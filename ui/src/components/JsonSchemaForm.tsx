import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Minimal JSON Schema node type. Plugins declare config schemas as JSON Schema
 * objects — this covers the subset we render.
 */
export interface JsonSchemaNode {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

interface JsonSchemaFormProps {
  schema: JsonSchemaNode;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Render a form from a JSON Schema object definition.
 * Supports string, number, integer, boolean, and enum fields.
 */
export function JsonSchemaForm({
  schema,
  values,
  onChange,
  errors,
  disabled,
}: JsonSchemaFormProps) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  function handleChange(key: string, value: unknown) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, prop]) => {
        const error = errors?.[key];
        const isRequired = required.has(key);

        if (prop.type === "boolean") {
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor={key}>{prop.title ?? key}{isRequired ? " *" : ""}</Label>
                {prop.description && (
                  <p className="text-xs text-muted-foreground">{prop.description}</p>
                )}
              </div>
              <input
                id={key}
                type="checkbox"
                checked={Boolean(values[key])}
                onChange={(e) => handleChange(key, e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 rounded border-input"
              />
            </div>
          );
        }

        if (prop.enum) {
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>{prop.title ?? key}{isRequired ? " *" : ""}</Label>
              {prop.description && (
                <p className="text-xs text-muted-foreground">{prop.description}</p>
              )}
              <select
                id={key}
                value={String(values[key] ?? "")}
                onChange={(e) => handleChange(key, e.target.value)}
                disabled={disabled}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Select...</option>
                {prop.enum.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </select>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          );
        }

        if (prop.type === "number" || prop.type === "integer") {
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={key}>{prop.title ?? key}{isRequired ? " *" : ""}</Label>
              {prop.description && (
                <p className="text-xs text-muted-foreground">{prop.description}</p>
              )}
              <Input
                id={key}
                type="number"
                value={values[key] != null ? String(values[key]) : ""}
                onChange={(e) =>
                  handleChange(key, e.target.value === "" ? undefined : Number(e.target.value))
                }
                disabled={disabled}
                min={prop.minimum}
                max={prop.maximum}
                step={prop.type === "integer" ? 1 : undefined}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          );
        }

        // Default: string
        const isTextarea = prop.format === "textarea" || (prop.maxLength && prop.maxLength > 200);
        return (
          <div key={key} className="space-y-1.5">
            <Label htmlFor={key}>{prop.title ?? key}{isRequired ? " *" : ""}</Label>
            {prop.description && (
              <p className="text-xs text-muted-foreground">{prop.description}</p>
            )}
            {isTextarea ? (
              <Textarea
                id={key}
                value={String(values[key] ?? "")}
                onChange={(e) => handleChange(key, e.target.value)}
                disabled={disabled}
              />
            ) : (
              <Input
                id={key}
                type={prop.format === "password" ? "password" : "text"}
                value={String(values[key] ?? "")}
                onChange={(e) => handleChange(key, e.target.value)}
                disabled={disabled}
                placeholder={prop.format === "uri" ? "https://..." : undefined}
              />
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Extract default values from a JSON Schema object definition.
 */
export function getDefaultValues(schema: JsonSchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) {
      result[key] = prop.default;
    } else if (prop.type === "boolean") {
      result[key] = false;
    } else if (prop.type === "number" || prop.type === "integer") {
      result[key] = undefined;
    } else {
      result[key] = "";
    }
  }
  return result;
}

/**
 * Validate form values against a JSON Schema object definition.
 * Returns a map of field → error message, or an empty object if valid.
 */
export function validateJsonSchemaForm(
  schema: JsonSchemaNode,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = values[key];

    if (required.has(key)) {
      if (value === undefined || value === null || value === "") {
        errors[key] = `${prop.title ?? key} is required`;
        continue;
      }
    }

    if (value === undefined || value === null || value === "") continue;

    if (prop.type === "string" && typeof value === "string") {
      if (prop.minLength && value.length < prop.minLength) {
        errors[key] = `Minimum ${prop.minLength} characters`;
      }
      if (prop.maxLength && value.length > prop.maxLength) {
        errors[key] = `Maximum ${prop.maxLength} characters`;
      }
    }

    if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
      if (prop.minimum !== undefined && value < prop.minimum) {
        errors[key] = `Minimum value is ${prop.minimum}`;
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        errors[key] = `Maximum value is ${prop.maximum}`;
      }
    }

    if (prop.enum && !prop.enum.includes(value)) {
      errors[key] = `Must be one of: ${prop.enum.join(", ")}`;
    }
  }

  return errors;
}
