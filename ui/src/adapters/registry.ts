import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { acpxLocalUIAdapter } from "./acpx-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { cursorCloudUIAdapter } from "./cursor-cloud";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { openClawUIAdapter } from "./openclaw";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { geminiLocalUIAdapter } from "./gemini-local";
import { grokLocalUIAdapter } from "./grok-local";
import { piLocalUIAdapter } from "./pi-local";
import { hermesLocalUIAdapter } from "./hermes-local";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";
import { loadDynamicParser, invalidateDynamicParser, setDynamicParserResultNotifier } from "./dynamic-loader";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "./schema-config-fields";

const uiAdapters: UIAdapterModule[] = [];
const adaptersByType = new Map<string, UIAdapterModule>();
const builtinTypes = new Set<string>();
const builtinAdaptersByType = new Map<string, UIAdapterModule>();
const activeExternalOverrides = new Set<string>();
const overrideGeneration = new Map<string, number>();
const adapterChangeListeners = new Set<() => void>();

export function onAdapterChange(fn: () => void): () => void {
  adapterChangeListeners.add(fn);
  return () => adapterChangeListeners.delete(fn);
}

function notifyAdapterChange(): void {
  for (const fn of adapterChangeListeners) fn();
}

setDynamicParserResultNotifier(notifyAdapterChange);

function registerBuiltInUIAdapters(): void {
  for (const adapter of [
    claudeLocalUIAdapter,
    acpxLocalUIAdapter,
    codexLocalUIAdapter,
    openCodeLocalUIAdapter,
    cursorLocalUIAdapter,
    cursorCloudUIAdapter,
    openClawUIAdapter,
    openClawGatewayUIAdapter,
    geminiLocalUIAdapter,
    grokLocalUIAdapter,
    piLocalUIAdapter,
    hermesLocalUIAdapter,
    processUIAdapter,
    httpUIAdapter,
  ]) {
    builtinTypes.add(adapter.type);
    builtinAdaptersByType.set(adapter.type, adapter);
    registerUIAdapter(adapter);
  }
}

export function registerUIAdapter(adapter: UIAdapterModule): void {
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === adapter.type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1, adapter);
  } else {
    uiAdapters.push(adapter);
  }
  adaptersByType.set(adapter.type, adapter);
  notifyAdapterChange();
}

export function unregisterUIAdapter(type: string): void {
  if (type === processUIAdapter.type || type === httpUIAdapter.type) return;
  const existingIndex = uiAdapters.findIndex((entry) => entry.type === type);
  if (existingIndex >= 0) {
    uiAdapters.splice(existingIndex, 1);
  }
  adaptersByType.delete(type);
}

export function findUIAdapter(type: string): UIAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

registerBuiltInUIAdapters();

export function getUIAdapter(type: string): UIAdapterModule {
  const builtIn = adaptersByType.get(type);
  if (builtIn) return builtIn;

  let loadStarted = false;
  return {
    type,
    label: type,
    parseStdoutLine: (line: string, ts: string) => {
      if (!loadStarted) {
        loadStarted = true;
        loadDynamicParser(type).then((parserModule) => {
          if (parserModule) {
            registerUIAdapter({
              type,
              label: type,
              parseStdoutLine: parserModule.parseStdoutLine,
              createStdoutParser: parserModule.createStdoutParser,
              ConfigFields: SchemaConfigFields,
              buildAdapterConfig: buildSchemaAdapterConfig,
            });
          }
        });
      }
      return processUIAdapter.parseStdoutLine(line, ts);
    },
    ConfigFields: SchemaConfigFields,
    buildAdapterConfig: buildSchemaAdapterConfig,
  };
}

export function syncExternalAdapters(
  serverAdapters: {
    type: string;
    label: string;
    disabled?: boolean;
    overrideDisabled?: boolean;
  }[],
): void {
  const enabledExternalTypes = new Set(
    serverAdapters.filter((a) => !a.disabled && !a.overrideDisabled).map((a) => a.type),
  );
  const allExternalTypes = new Set(serverAdapters.map((a) => a.type));

  for (const builtinType of builtinTypes) {
    const originalBuiltin = builtinAdaptersByType.get(builtinType);
    if (!originalBuiltin) continue;

    const hasExternal = allExternalTypes.has(builtinType);
    const externalEnabled = enabledExternalTypes.has(builtinType);
    const wasOverridden = activeExternalOverrides.has(builtinType);

    if (hasExternal && externalEnabled && !wasOverridden) {
      activeExternalOverrides.add(builtinType);
      const gen = (overrideGeneration.get(builtinType) ?? 0) + 1;
      overrideGeneration.set(builtinType, gen);
      const externalEntry = serverAdapters.find((a) => a.type === builtinType);
      const label = externalEntry?.label ?? builtinType;
      let loadStarted = false;

      registerUIAdapter({
        type: builtinType,
        label,
        parseStdoutLine: (line: string, ts: string) => {
          if (!loadStarted) {
            loadStarted = true;
            loadDynamicParser(builtinType).then((parserModule) => {
              if (parserModule && overrideGeneration.get(builtinType) === gen) {
                registerUIAdapter({
                  type: builtinType,
                  label,
                  parseStdoutLine: parserModule.parseStdoutLine,
                  createStdoutParser: parserModule.createStdoutParser,
                  ConfigFields: originalBuiltin.ConfigFields,
                  buildAdapterConfig: originalBuiltin.buildAdapterConfig,
                });
              }
            });
          }
          return originalBuiltin.parseStdoutLine(line, ts);
        },
        ConfigFields: originalBuiltin.ConfigFields,
        buildAdapterConfig: originalBuiltin.buildAdapterConfig,
      });
    } else if ((!hasExternal || !externalEnabled) && wasOverridden) {
      activeExternalOverrides.delete(builtinType);
      overrideGeneration.delete(builtinType);
      invalidateDynamicParser(builtinType);
      registerUIAdapter(originalBuiltin);
    }
  }

  for (const { type, label, disabled, overrideDisabled } of serverAdapters) {
    if (disabled || overrideDisabled || builtinTypes.has(type)) continue;
    const existing = adaptersByType.get(type);
    if (existing && existing !== processUIAdapter) continue;

    let loadStarted = false;
    const fallbackParser = existing?.parseStdoutLine ?? processUIAdapter.parseStdoutLine;

    registerUIAdapter({
      type,
      label,
      parseStdoutLine: (line: string, ts: string) => {
        if (!loadStarted) {
          loadStarted = true;
          loadDynamicParser(type).then((parserModule) => {
            if (parserModule) {
              registerUIAdapter({
                type,
                label,
                parseStdoutLine: parserModule.parseStdoutLine,
                createStdoutParser: parserModule.createStdoutParser,
                ConfigFields: existing?.ConfigFields ?? SchemaConfigFields,
                buildAdapterConfig: existing?.buildAdapterConfig ?? buildSchemaAdapterConfig,
              });
            }
          });
        }
        return fallbackParser(line, ts);
      },
      ConfigFields: existing?.ConfigFields ?? SchemaConfigFields,
      buildAdapterConfig: existing?.buildAdapterConfig ?? buildSchemaAdapterConfig,
    });
  }
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}
