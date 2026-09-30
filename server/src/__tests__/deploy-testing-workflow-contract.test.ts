import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const BASH =
  process.platform === "win32"
    ? join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe"
      )
    : "bash";

function repoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

function runRevisionVerifier(testCase: string, deploySha: string) {
  return spawnSync(
    BASH,
    [
      "-c",
      `
        gh() {
          case "$2" in
            */compare/*)
              if [[ "$TEST_CASE" == "non-main" ]]; then
                printf '%s\\n' diverged
              else
                printf '%s\\n' ahead
              fi
              ;;
            */check-runs*)
              if [[ "$TEST_CASE" == "failed-ci" ]]; then
                printf '%s\\n' failure
              elif [[ "$TEST_CASE" == "wrong-issuer" ]]; then
                printf '%s\\n' ''
              else
                printf '%s\\n' success
              fi
              ;;
            */commits/*)
              [[ "$TEST_CASE" != "missing-commit" ]] || return 1
              printf '%s\\n' "$TEST_SHA"
              ;;
            *) return 99 ;;
          esac
        }
        export -f gh
        source scripts/deploy/verify-testing-revision.sh "$TEST_SHA"
      `,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "MeteoriteLabs/AoA",
        TEST_CASE: testCase,
        TEST_SHA: deploySha,
      },
    }
  );
}

describe("testing deployment workflow contract", () => {
  it("requires an exact, tested SHA from main history", () => {
    const source = repoFile(".github/workflows/deploy-testing.yml");
    const verifier = repoFile("scripts/deploy/verify-testing-revision.sh");
    const workflow = parse(source) as any;
    const input = workflow.on.workflow_dispatch.inputs.deploy_sha;

    expect(input.required).toBe(true);
    expect(input.type).toBe("string");
    expect(source).toContain("MANUAL_SHA: ${{ inputs.deploy_sha }}");
    expect(source).toContain(
      'bash scripts/deploy/verify-testing-revision.sh "$DEPLOY_SHA"'
    );
    expect(verifier).toContain(
      '"repos/$GITHUB_REPOSITORY/compare/$DEPLOY_SHA...main"'
    );
    expect(verifier).toContain(
      '.name == "ci-required" and .app.slug == "github-actions"'
    );
    expect(verifier).toContain("sort_by(.id)");
    expect(verifier).toContain('[[ "$conclusion" == "success" ]]');
    expect(source).toContain("ref: ${{ steps.revision.outputs.sha }}");
    expect(source).toContain('test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"');
    expect(source).toContain('"$RUNNER_TEMP/remote-compose-deploy.sh"');
    expect(source).not.toContain("fetch-depth: 0");
    expect(source).not.toContain("${{ github.sha }}");
  });

  it.each([
    ["malformed", "ABC", "not 40 lowercase hex characters"],
    ["missing-commit", "a".repeat(40), "does not identify a repository commit"],
    ["non-main", "b".repeat(40), "not an ancestor of origin/main"],
    ["failed-ci", "c".repeat(40), "ci-required check is not successful"],
    ["wrong-issuer", "d".repeat(40), "ci-required check is not successful"],
  ])(
    "rejects an ineligible revision: %s",
    (testCase, deploySha, expectedError) => {
      const result = runRevisionVerifier(testCase, deploySha);

      expect(result.status).not.toBe(0);
      if (expectedError) expect(result.stderr).toContain(expectedError);
    }
  );

  it("accepts an exact successful main revision", () => {
    const result = runRevisionVerifier("success", "e".repeat(40));

    expect(result.status, result.stderr).toBe(0);
  });

  it("threads the same SHA through image identity and health evidence", () => {
    const compose = repoFile("docker-compose.yml");
    const dockerfile = repoFile("Dockerfile");
    const remoteDeploy = repoFile("scripts/deploy/remote-compose-deploy.sh");
    const healthRoute = repoFile("server/src/routes/health.ts");

    expect(compose).toContain(
      "AOA_IMAGE_REVISION: ${AOA_IMAGE_REVISION:-unknown}"
    );
    expect(compose).toContain("AOA_DEPLOY_SHA: ${AOA_DEPLOY_SHA:-}");
    expect(compose).toContain(
      "AOA_MARKETPLACE_SKILLS_WRITE_ROOT: ${AOA_MARKETPLACE_SKILLS_WRITE_ROOT:-legacy}",
    );
    expect(dockerfile).toContain(
      'LABEL org.opencontainers.image.revision="${AOA_IMAGE_REVISION}"'
    );
    expect(remoteDeploy).toContain('AOA_IMAGE="aoa:$image_sha"');
    expect(remoteDeploy).toContain('AOA_DEPLOY_SHA="$image_sha"');
    expect(remoteDeploy).toContain(
      "docker image inspect --format '{{.Id}}' \"aoa:$image_sha\""
    );
    expect(remoteDeploy).toContain(
      "docker inspect --format '{{.Image}}' \"$running_container_id\""
    );
    expect(remoteDeploy).toContain(
      '[[ "$running_image_id" == "$expected_image_id" ]]'
    );
    expect(remoteDeploy).toContain('[[ "$image_revision" == "$image_sha" ]]');
    expect(remoteDeploy).toContain(
      'image aoa:$image_sha does not provide revision evidence'
    );
    expect(remoteDeploy).not.toContain(
      'if [[ -n "$image_revision"'
    );
    expect(remoteDeploy).toContain(
      'grep -Fq -- "\\"revision\\":\\"$image_sha\\"" <<<"$local_health"'
    );
    expect(remoteDeploy).toContain(
      'grep -Fq -- "\\"revision\\":\\"$image_sha\\"" <<<"$public_health"'
    );
    expect(remoteDeploy).toContain(
      'verify_release_health "$RELEASE_DIR" "$DEPLOY_SHA"'
    );
    expect(remoteDeploy).toContain(
      'verify_release_health "$PREVIOUS_RELEASE" "$previous_sha" legacy-rollback'
    );
    expect(remoteDeploy).toContain(
      '"$verification_mode" != "legacy-rollback"'
    );
    expect(remoteDeploy).toContain(
      '"$release" != "$PREVIOUS_RELEASE"'
    );
    expect(remoteDeploy).toContain(
      "grep -Fq -- '\"revision\":' <<<\"$local_health\""
    );
    expect(remoteDeploy).toContain(
      "grep -Fq -- '\"revision\":' <<<\"$public_health\""
    );
    expect(healthRoute).toContain(
      "revision: process.env.AOA_DEPLOY_SHA || null"
    );
  });

  it("keeps the remote deployment script syntactically executable", () => {
    const result = spawnSync(
      BASH,
      [
        "-n",
        "scripts/deploy/verify-testing-revision.sh",
        "scripts/deploy/remote-compose-deploy.sh",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
