$ErrorActionPreference = 'Stop'
try {
 docker start universe-preparation-e9637db9
 if ($LASTEXITCODE -ne 0) { throw 'Container start failed' }
 docker exec universe-preparation-e9637db9 node /workspace/f5-prepare-full.mjs
 if ($LASTEXITCODE -ne 0) { throw 'Checkout preparation failed' }
 foreach ($label in @('install','build0','build1','build2','build3','build4','build5','exports','typecheck','shard1','shard2','shard3','shard4','build')) {
  docker exec universe-preparation-e9637db9 node /workspace/f5-full-run.mjs $label
  if ($LASTEXITCODE -ne 0) { throw ('Qualification failed at ' + $label) }
  if ($label -in @('shard1','shard2','shard3','shard4')) {
   docker stop -t 5 universe-preparation-e9637db9
   if ($LASTEXITCODE -ne 0) { throw 'Container stop failed' }
   docker start universe-preparation-e9637db9
   if ($LASTEXITCODE -ne 0) { throw 'Container restart failed' }
  }
 }
} finally { docker stop -t 5 universe-preparation-e9637db9 }
