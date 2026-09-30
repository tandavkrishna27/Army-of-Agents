from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).parent
src=Path('C:/Users/TK/AppData/Local/Temp/universe-fixture-stage-a-5558c9523949402285269313d571136d/instrumented.test.ts').read_text(encoding='utf-8')
repo='C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.worktrees/universe-f4-fixture-repair'
raw=subprocess.check_output(['git','show','4aebfa0f4aaf011cfd85347246c18d3cbde305ba:packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts'],cwd=repo).decode()
assert src[src.index('  it('):]==raw[raw.index('  it('):]
src=src.replace('import net from "node:net";', 'import net from "node:net";\nimport { appendFileSync } from "node:fs";')
start=src.index('  const emit =');end=src.index('  emit("start");',start)
src=src[:start]+'''  const emit = (event: string) => {
    const record = { fixture: "backup-non-system", stage: name, event, elapsedMs: Math.round(performance.now() - started), pid: process.pid, utc: new Date().toISOString() };
    appendFileSync("/workspace/f5-attribution-20260913-logs/stages.jsonl", JSON.stringify(record) + "\\n");
    console.info(JSON.stringify(record));
  };
'''+src[end:]
(root/'instrumented.test.ts').write_bytes(src.encode())
(root/'input.json').write_text(json.dumps({'sha':'4aebfa0f4aaf011cfd85347246c18d3cbde305ba','target':'packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts','originalSha256':hashlib.sha256(raw.encode()).hexdigest(),'instrumentedSha256':hashlib.sha256(src.encode()).hexdigest(),'testBodiesUnchanged':True},indent=2),encoding='utf-8')
print((root/'input.json').read_text())
