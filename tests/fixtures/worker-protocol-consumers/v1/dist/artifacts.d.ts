import { z } from "zod";
/**
 * True iff `path` is a safe RELATIVE POSIX workspace path: non-empty, ≤4096
 * chars, no absolute/`/`-prefixed form, no backslash, no `:` (drive/ADS/scheme),
 * no NUL/control byte, and no empty / `.` / `..` / over-long segment.
 */
export declare function isSafeWorkspacePath(path: string): boolean;
/** A workspace-relative path field. */
export declare const workspacePathSchema: z.ZodEffects<z.ZodString, string, string>;
/** The ordinary attempt object-key prefix (ends with `/`). */
export declare function expectedAttemptObjectPrefix(input: {
    organizationId: string;
    jobId: string;
    attempt: number;
}): string;
/** The DISTINCT quarantine object-key prefix (a separate `quarantine/` root). */
export declare function expectedQuarantineObjectPrefix(input: {
    organizationId: string;
    jobId: string;
    attempt: number;
}): string;
/** The strict V1 workspace base: how the snapshot/patch base was captured. */
export declare const workspaceBaseV1Schema: z.ZodEffects<z.ZodObject<{
    kind: z.ZodEnum<["git_commit", "content_manifest"]>;
    algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
    revision: z.ZodString;
    dirty: z.ZodBoolean;
    caseMode: z.ZodEnum<["sensitive", "insensitive_preserving"]>;
    ignorePolicy: z.ZodObject<{
        kind: z.ZodEnum<["gitignore_plus_aoa", "explicit"]>;
        digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
    }, "strict", z.ZodTypeAny, {
        digest: string & z.BRAND<"Sha256Digest">;
        kind: "gitignore_plus_aoa" | "explicit";
    }, {
        digest: string;
        kind: "gitignore_plus_aoa" | "explicit";
    }>;
    inclusion: z.ZodObject<{
        tracked: z.ZodLiteral<true>;
        untracked: z.ZodEnum<["include", "exclude"]>;
        ignored: z.ZodLiteral<false>;
    }, "strict", z.ZodTypeAny, {
        tracked: true;
        untracked: "include" | "exclude";
        ignored: false;
    }, {
        tracked: true;
        untracked: "include" | "exclude";
        ignored: false;
    }>;
}, "strict", z.ZodTypeAny, {
    dirty: boolean;
    kind: "git_commit" | "content_manifest";
    algorithm: "git_sha1" | "git_sha256" | "sha256";
    revision: string;
    caseMode: "sensitive" | "insensitive_preserving";
    ignorePolicy: {
        digest: string & z.BRAND<"Sha256Digest">;
        kind: "gitignore_plus_aoa" | "explicit";
    };
    inclusion: {
        tracked: true;
        untracked: "include" | "exclude";
        ignored: false;
    };
}, {
    dirty: boolean;
    kind: "git_commit" | "content_manifest";
    algorithm: "git_sha1" | "git_sha256" | "sha256";
    revision: string;
    caseMode: "sensitive" | "insensitive_preserving";
    ignorePolicy: {
        digest: string;
        kind: "gitignore_plus_aoa" | "explicit";
    };
    inclusion: {
        tracked: true;
        untracked: "include" | "exclude";
        ignored: false;
    };
}>, {
    dirty: boolean;
    kind: "git_commit" | "content_manifest";
    algorithm: "git_sha1" | "git_sha256" | "sha256";
    revision: string;
    caseMode: "sensitive" | "insensitive_preserving";
    ignorePolicy: {
        digest: string & z.BRAND<"Sha256Digest">;
        kind: "gitignore_plus_aoa" | "explicit";
    };
    inclusion: {
        tracked: true;
        untracked: "include" | "exclude";
        ignored: false;
    };
}, {
    dirty: boolean;
    kind: "git_commit" | "content_manifest";
    algorithm: "git_sha1" | "git_sha256" | "sha256";
    revision: string;
    caseMode: "sensitive" | "insensitive_preserving";
    ignorePolicy: {
        digest: string;
        kind: "gitignore_plus_aoa" | "explicit";
    };
    inclusion: {
        tracked: true;
        untracked: "include" | "exclude";
        ignored: false;
    };
}>;
export type WorkspaceBaseV1 = z.infer<typeof workspaceBaseV1Schema>;
/** The V1 workspace entry kinds — symlinks are NOT representable in v1. */
export declare const WORKSPACE_ENTRY_KINDS: readonly ["file", "directory"];
export declare const workspaceEntryKindSchema: z.ZodEnum<["file", "directory"]>;
export type WorkspaceEntryKind = (typeof WORKSPACE_ENTRY_KINDS)[number];
/** The workspace-entry / artifact provenance vocabulary (single source). */
export declare const WORKSPACE_PROVENANCE: readonly ["tracked", "untracked", "generated"];
export declare const workspaceProvenanceSchema: z.ZodEnum<["tracked", "untracked", "generated"]>;
export type WorkspaceProvenance = (typeof WORKSPACE_PROVENANCE)[number];
/** A single captured workspace entry. Files carry a content hash; directories do
 * not (and are not executable). Symlinks are rejected via the kind enum. */
export declare const workspaceEntrySchema: z.ZodEffects<z.ZodObject<{
    path: z.ZodEffects<z.ZodString, string, string>;
    kind: z.ZodEnum<["file", "directory"]>;
    provenance: z.ZodEnum<["tracked", "untracked", "generated"]>;
    sizeBytes: z.ZodNumber;
    sha256: z.ZodNullable<z.ZodBranded<z.ZodString, "Sha256Digest">>;
    executable: z.ZodBoolean;
}, "strict", z.ZodTypeAny, {
    path: string;
    kind: "file" | "directory";
    sha256: (string & z.BRAND<"Sha256Digest">) | null;
    provenance: "tracked" | "untracked" | "generated";
    sizeBytes: number;
    executable: boolean;
}, {
    path: string;
    kind: "file" | "directory";
    sha256: string | null;
    provenance: "tracked" | "untracked" | "generated";
    sizeBytes: number;
    executable: boolean;
}>, {
    path: string;
    kind: "file" | "directory";
    sha256: (string & z.BRAND<"Sha256Digest">) | null;
    provenance: "tracked" | "untracked" | "generated";
    sizeBytes: number;
    executable: boolean;
}, {
    path: string;
    kind: "file" | "directory";
    sha256: string | null;
    provenance: "tracked" | "untracked" | "generated";
    sizeBytes: number;
    executable: boolean;
}>;
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
/** The strict V1 full-workspace snapshot manifest. */
export declare const workspaceManifestV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    base: z.ZodEffects<z.ZodObject<{
        kind: z.ZodEnum<["git_commit", "content_manifest"]>;
        algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
        revision: z.ZodString;
        dirty: z.ZodBoolean;
        caseMode: z.ZodEnum<["sensitive", "insensitive_preserving"]>;
        ignorePolicy: z.ZodObject<{
            kind: z.ZodEnum<["gitignore_plus_aoa", "explicit"]>;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        }, "strict", z.ZodTypeAny, {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        }, {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        }>;
        inclusion: z.ZodObject<{
            tracked: z.ZodLiteral<true>;
            untracked: z.ZodEnum<["include", "exclude"]>;
            ignored: z.ZodLiteral<false>;
        }, "strict", z.ZodTypeAny, {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        }, {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        }>;
    }, "strict", z.ZodTypeAny, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }>, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }>;
    snapshotProvenance: z.ZodObject<{
        capturedAt: z.ZodString;
        sourceTargetId: z.ZodBranded<z.ZodString, "TargetId">;
        folderGrantId: z.ZodNullable<z.ZodString>;
        captureToolVersion: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        capturedAt: string;
        sourceTargetId: string & z.BRAND<"TargetId">;
        folderGrantId: string | null;
        captureToolVersion: string;
    }, {
        capturedAt: string;
        sourceTargetId: string;
        folderGrantId: string | null;
        captureToolVersion: string;
    }>;
    entries: z.ZodArray<z.ZodEffects<z.ZodObject<{
        path: z.ZodEffects<z.ZodString, string, string>;
        kind: z.ZodEnum<["file", "directory"]>;
        provenance: z.ZodEnum<["tracked", "untracked", "generated"]>;
        sizeBytes: z.ZodNumber;
        sha256: z.ZodNullable<z.ZodBranded<z.ZodString, "Sha256Digest">>;
        executable: z.ZodBoolean;
    }, "strict", z.ZodTypeAny, {
        path: string;
        kind: "file" | "directory";
        sha256: (string & z.BRAND<"Sha256Digest">) | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }, {
        path: string;
        kind: "file" | "directory";
        sha256: string | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }>, {
        path: string;
        kind: "file" | "directory";
        sha256: (string & z.BRAND<"Sha256Digest">) | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }, {
        path: string;
        kind: "file" | "directory";
        sha256: string | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    entries: {
        path: string;
        kind: "file" | "directory";
        sha256: (string & z.BRAND<"Sha256Digest">) | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }[];
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    artifactId: string & z.BRAND<"ArtifactId">;
    snapshotProvenance: {
        capturedAt: string;
        sourceTargetId: string & z.BRAND<"TargetId">;
        folderGrantId: string | null;
        captureToolVersion: string;
    };
}, {
    entries: {
        path: string;
        kind: "file" | "directory";
        sha256: string | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }[];
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    organizationId: string;
    companyId: string;
    artifactId: string;
    snapshotProvenance: {
        capturedAt: string;
        sourceTargetId: string;
        folderGrantId: string | null;
        captureToolVersion: string;
    };
}>, {
    entries: {
        path: string;
        kind: "file" | "directory";
        sha256: (string & z.BRAND<"Sha256Digest">) | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }[];
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    artifactId: string & z.BRAND<"ArtifactId">;
    snapshotProvenance: {
        capturedAt: string;
        sourceTargetId: string & z.BRAND<"TargetId">;
        folderGrantId: string | null;
        captureToolVersion: string;
    };
}, {
    entries: {
        path: string;
        kind: "file" | "directory";
        sha256: string | null;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        executable: boolean;
    }[];
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    organizationId: string;
    companyId: string;
    artifactId: string;
    snapshotProvenance: {
        capturedAt: string;
        sourceTargetId: string;
        folderGrantId: string | null;
        captureToolVersion: string;
    };
}>;
export type WorkspaceManifestV1 = z.infer<typeof workspaceManifestV1Schema>;
/** The locked patch-operation vocabulary. */
export declare const PATCH_OPERATION_KINDS: readonly ["create", "modify", "delete", "rename"];
/** A single patch operation. `create`/`modify`/`rename` carry a result hash +
 * size; `delete` carries only a path; `rename` additionally carries `fromPath`. */
export declare const patchOperationSchema: z.ZodDiscriminatedUnion<"op", [z.ZodObject<{
    path: z.ZodEffects<z.ZodString, string, string>;
    resultSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    sizeBytes: z.ZodNumber;
    op: z.ZodLiteral<"create">;
}, "strict", z.ZodTypeAny, {
    path: string;
    sizeBytes: number;
    op: "create";
    resultSha256: string & z.BRAND<"Sha256Digest">;
}, {
    path: string;
    sizeBytes: number;
    op: "create";
    resultSha256: string;
}>, z.ZodObject<{
    path: z.ZodEffects<z.ZodString, string, string>;
    resultSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    sizeBytes: z.ZodNumber;
    op: z.ZodLiteral<"modify">;
}, "strict", z.ZodTypeAny, {
    path: string;
    sizeBytes: number;
    op: "modify";
    resultSha256: string & z.BRAND<"Sha256Digest">;
}, {
    path: string;
    sizeBytes: number;
    op: "modify";
    resultSha256: string;
}>, z.ZodObject<{
    op: z.ZodLiteral<"delete">;
    path: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    path: string;
    op: "delete";
}, {
    path: string;
    op: "delete";
}>, z.ZodObject<{
    path: z.ZodEffects<z.ZodString, string, string>;
    resultSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    sizeBytes: z.ZodNumber;
    op: z.ZodLiteral<"rename">;
    fromPath: z.ZodEffects<z.ZodString, string, string>;
}, "strict", z.ZodTypeAny, {
    path: string;
    sizeBytes: number;
    op: "rename";
    resultSha256: string & z.BRAND<"Sha256Digest">;
    fromPath: string;
}, {
    path: string;
    sizeBytes: number;
    op: "rename";
    resultSha256: string;
    fromPath: string;
}>]>;
export type PatchOperation = z.infer<typeof patchOperationSchema>;
/** The strict V1 workspace patch manifest (base → result). */
export declare const workspacePatchManifestV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    base: z.ZodEffects<z.ZodObject<{
        kind: z.ZodEnum<["git_commit", "content_manifest"]>;
        algorithm: z.ZodEnum<["git_sha1", "git_sha256", "sha256"]>;
        revision: z.ZodString;
        dirty: z.ZodBoolean;
        caseMode: z.ZodEnum<["sensitive", "insensitive_preserving"]>;
        ignorePolicy: z.ZodObject<{
            kind: z.ZodEnum<["gitignore_plus_aoa", "explicit"]>;
            digest: z.ZodBranded<z.ZodString, "Sha256Digest">;
        }, "strict", z.ZodTypeAny, {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        }, {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        }>;
        inclusion: z.ZodObject<{
            tracked: z.ZodLiteral<true>;
            untracked: z.ZodEnum<["include", "exclude"]>;
            ignored: z.ZodLiteral<false>;
        }, "strict", z.ZodTypeAny, {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        }, {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        }>;
    }, "strict", z.ZodTypeAny, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }>, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }, {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    }>;
    baseManifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    resultManifestHash: z.ZodBranded<z.ZodString, "Sha256Digest">;
    operations: z.ZodArray<z.ZodDiscriminatedUnion<"op", [z.ZodObject<{
        path: z.ZodEffects<z.ZodString, string, string>;
        resultSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        sizeBytes: z.ZodNumber;
        op: z.ZodLiteral<"create">;
    }, "strict", z.ZodTypeAny, {
        path: string;
        sizeBytes: number;
        op: "create";
        resultSha256: string & z.BRAND<"Sha256Digest">;
    }, {
        path: string;
        sizeBytes: number;
        op: "create";
        resultSha256: string;
    }>, z.ZodObject<{
        path: z.ZodEffects<z.ZodString, string, string>;
        resultSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        sizeBytes: z.ZodNumber;
        op: z.ZodLiteral<"modify">;
    }, "strict", z.ZodTypeAny, {
        path: string;
        sizeBytes: number;
        op: "modify";
        resultSha256: string & z.BRAND<"Sha256Digest">;
    }, {
        path: string;
        sizeBytes: number;
        op: "modify";
        resultSha256: string;
    }>, z.ZodObject<{
        op: z.ZodLiteral<"delete">;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        path: string;
        op: "delete";
    }, {
        path: string;
        op: "delete";
    }>, z.ZodObject<{
        path: z.ZodEffects<z.ZodString, string, string>;
        resultSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        sizeBytes: z.ZodNumber;
        op: z.ZodLiteral<"rename">;
        fromPath: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        path: string;
        sizeBytes: number;
        op: "rename";
        resultSha256: string & z.BRAND<"Sha256Digest">;
        fromPath: string;
    }, {
        path: string;
        sizeBytes: number;
        op: "rename";
        resultSha256: string;
        fromPath: string;
    }>]>, "many">;
}, "strict", z.ZodTypeAny, {
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    artifactId: string & z.BRAND<"ArtifactId">;
    baseManifestHash: string & z.BRAND<"Sha256Digest">;
    resultManifestHash: string & z.BRAND<"Sha256Digest">;
    operations: ({
        path: string;
        sizeBytes: number;
        op: "create";
        resultSha256: string & z.BRAND<"Sha256Digest">;
    } | {
        path: string;
        sizeBytes: number;
        op: "modify";
        resultSha256: string & z.BRAND<"Sha256Digest">;
    } | {
        path: string;
        op: "delete";
    } | {
        path: string;
        sizeBytes: number;
        op: "rename";
        resultSha256: string & z.BRAND<"Sha256Digest">;
        fromPath: string;
    })[];
}, {
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    artifactId: string;
    baseManifestHash: string;
    resultManifestHash: string;
    operations: ({
        path: string;
        sizeBytes: number;
        op: "create";
        resultSha256: string;
    } | {
        path: string;
        sizeBytes: number;
        op: "modify";
        resultSha256: string;
    } | {
        path: string;
        op: "delete";
    } | {
        path: string;
        sizeBytes: number;
        op: "rename";
        resultSha256: string;
        fromPath: string;
    })[];
}>, {
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string & z.BRAND<"Sha256Digest">;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    artifactId: string & z.BRAND<"ArtifactId">;
    baseManifestHash: string & z.BRAND<"Sha256Digest">;
    resultManifestHash: string & z.BRAND<"Sha256Digest">;
    operations: ({
        path: string;
        sizeBytes: number;
        op: "create";
        resultSha256: string & z.BRAND<"Sha256Digest">;
    } | {
        path: string;
        sizeBytes: number;
        op: "modify";
        resultSha256: string & z.BRAND<"Sha256Digest">;
    } | {
        path: string;
        op: "delete";
    } | {
        path: string;
        sizeBytes: number;
        op: "rename";
        resultSha256: string & z.BRAND<"Sha256Digest">;
        fromPath: string;
    })[];
}, {
    base: {
        dirty: boolean;
        kind: "git_commit" | "content_manifest";
        algorithm: "git_sha1" | "git_sha256" | "sha256";
        revision: string;
        caseMode: "sensitive" | "insensitive_preserving";
        ignorePolicy: {
            digest: string;
            kind: "gitignore_plus_aoa" | "explicit";
        };
        inclusion: {
            tracked: true;
            untracked: "include" | "exclude";
            ignored: false;
        };
    };
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    artifactId: string;
    baseManifestHash: string;
    resultManifestHash: string;
    operations: ({
        path: string;
        sizeBytes: number;
        op: "create";
        resultSha256: string;
    } | {
        path: string;
        sizeBytes: number;
        op: "modify";
        resultSha256: string;
    } | {
        path: string;
        op: "delete";
    } | {
        path: string;
        sizeBytes: number;
        op: "rename";
        resultSha256: string;
        fromPath: string;
    })[];
}>;
export type WorkspacePatchManifestV1 = z.infer<typeof workspacePatchManifestV1Schema>;
/** The locked artifact-kind vocabulary (including the catch-all `other`). */
export declare const ARTIFACT_KINDS: readonly ["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"];
export declare const artifactKindSchema: z.ZodEnum<["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]>;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
/** EVERY V1 artifact kind is restricted — there is no weaker class in v1. */
export declare const RESTRICTED_ARTIFACT_KINDS: readonly ["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"];
/** The only V1 artifact sensitivity: `restricted`. A future normal/public kind
 * requires a named schema addition and a policy decision. */
export declare const artifactSensitivitySchema: z.ZodLiteral<"restricted">;
export type ArtifactSensitivity = z.infer<typeof artifactSensitivitySchema>;
/** The strict V1 artifact manifest. Size, hash, kind, and retention are required;
 * every kind is `restricted`; the object key is pinned to its org/job/attempt. */
export declare const artifactManifestV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    kind: z.ZodEnum<["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]>;
    sensitivity: z.ZodLiteral<"restricted">;
    retention: z.ZodEnum<["ephemeral", "run", "audit", "checkpoint"]>;
    objectKey: z.ZodString;
    sizeBytes: z.ZodNumber;
    sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    contentType: z.ZodString;
    createdAt: z.ZodString;
}, "strict", z.ZodTypeAny, {
    kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
    sha256: string & z.BRAND<"Sha256Digest">;
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    createdAt: string;
    sizeBytes: number;
    artifactId: string & z.BRAND<"ArtifactId">;
    sensitivity: "restricted";
    retention: "ephemeral" | "run" | "audit" | "checkpoint";
    objectKey: string;
    contentType: string;
}, {
    kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
    sha256: string;
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    createdAt: string;
    sizeBytes: number;
    artifactId: string;
    sensitivity: "restricted";
    retention: "ephemeral" | "run" | "audit" | "checkpoint";
    objectKey: string;
    contentType: string;
}>, {
    kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
    sha256: string & z.BRAND<"Sha256Digest">;
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    createdAt: string;
    sizeBytes: number;
    artifactId: string & z.BRAND<"ArtifactId">;
    sensitivity: "restricted";
    retention: "ephemeral" | "run" | "audit" | "checkpoint";
    objectKey: string;
    contentType: string;
}, {
    kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
    sha256: string;
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    createdAt: string;
    sizeBytes: number;
    artifactId: string;
    sensitivity: "restricted";
    retention: "ephemeral" | "run" | "audit" | "checkpoint";
    objectKey: string;
    contentType: string;
}>;
export type ArtifactManifestV1 = z.infer<typeof artifactManifestV1Schema>;
/** A worker's request for an ordinary (fenced) upload/download grant. */
export declare const artifactTransferGrantRequestV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    operation: z.ZodEnum<["upload", "download"]>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    expectedObjectKey: z.ZodString;
    expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    maxBytes: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    artifactId: string & z.BRAND<"ArtifactId">;
    operation: "download" | "upload";
    expectedObjectKey: string;
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    artifactId: string;
    operation: "download" | "upload";
    expectedObjectKey: string;
    expectedSha256: string;
    maxBytes: number;
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    artifactId: string & z.BRAND<"ArtifactId">;
    operation: "download" | "upload";
    expectedObjectKey: string;
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    artifactId: string;
    operation: "download" | "upload";
    expectedObjectKey: string;
    expectedSha256: string;
    maxBytes: number;
}>;
export type ArtifactTransferGrantRequestV1 = z.infer<typeof artifactTransferGrantRequestV1Schema>;
/** A scoped PUT grant for an ordinary artifact upload. */
export declare const artifactUploadGrantV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    operation: z.ZodLiteral<"upload">;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    method: z.ZodLiteral<"PUT">;
    url: z.ZodString;
    headers: z.ZodRecord<z.ZodString, z.ZodString>;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    maxBytes: z.ZodNumber;
    expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    objectKey: z.ZodString;
    redaction: z.ZodLiteral<"secret">;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string & z.BRAND<"ArtifactId">;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "upload";
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
}, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "upload";
    expectedSha256: string;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
}>, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string & z.BRAND<"ArtifactId">;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "upload";
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
}, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "upload";
    expectedSha256: string;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
}>;
export type ArtifactUploadGrantV1 = z.infer<typeof artifactUploadGrantV1Schema>;
/** A scoped GET grant for an ordinary artifact download. */
export declare const artifactDownloadGrantV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    operation: z.ZodLiteral<"download">;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    method: z.ZodLiteral<"GET">;
    url: z.ZodString;
    headers: z.ZodRecord<z.ZodString, z.ZodString>;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    maxBytes: z.ZodNumber;
    expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    objectKey: z.ZodString;
    redaction: z.ZodLiteral<"secret">;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string & z.BRAND<"ArtifactId">;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "download";
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
    method: "GET";
    issuedAt: string;
    redaction: "secret";
}, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "download";
    expectedSha256: string;
    maxBytes: number;
    method: "GET";
    issuedAt: string;
    redaction: "secret";
}>, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string & z.BRAND<"ArtifactId">;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "download";
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
    method: "GET";
    issuedAt: string;
    redaction: "secret";
}, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string;
    objectKey: string;
    url: string;
    headers: Record<string, string>;
    operation: "download";
    expectedSha256: string;
    maxBytes: number;
    method: "GET";
    issuedAt: string;
    redaction: "secret";
}>;
export type ArtifactDownloadGrantV1 = z.infer<typeof artifactDownloadGrantV1Schema>;
/**
 * The ordinary artifact-commit payload. It carries the COMPLETE active fence
 * (workerId/jobId/attempt/leaseId/fenceToken) plus the artifact manifest. The
 * schema deliberately does NOT decide whether that fence is current — staleness
 * is authoritative receiver state (PRT-007/JOB-004). It binds the commit's
 * job/attempt to the manifest so a wrong prefix fails at commit.
 */
export declare const artifactCommitPayloadV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    manifest: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        kind: z.ZodEnum<["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]>;
        sensitivity: z.ZodLiteral<"restricted">;
        retention: z.ZodEnum<["ephemeral", "run", "audit", "checkpoint"]>;
        objectKey: z.ZodString;
        sizeBytes: z.ZodNumber;
        sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        contentType: z.ZodString;
        createdAt: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }>, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    workerId: string & z.BRAND<"WorkerId">;
    leaseId: string & z.BRAND<"LeaseId">;
    fenceToken: string & z.BRAND<"FenceToken">;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    workerId: string;
    leaseId: string;
    fenceToken: string;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
}>;
export type ArtifactCommitPayloadV1 = z.infer<typeof artifactCommitPayloadV1Schema>;
/** The locked quarantine-reason vocabulary. */
export declare const QUARANTINE_REASONS: readonly ["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"];
export declare const quarantineReasonSchema: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];
/**
 * A device-authenticated request for a quarantine PUT grant. The authenticator is
 * `targetId` + `deviceGeneration`, NOT a live lease; `observedLeaseId` /
 * `observedFenceToken` are recorded as observed (non-authoritative) identity. The
 * object key is bound to the DISTINCT quarantine prefix and the exact
 * org/job/attempt/hash/size. There is no apply/promote/checkpoint-selection field.
 */
export declare const quarantineGrantPayloadV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    targetId: z.ZodBranded<z.ZodString, "TargetId">;
    deviceGeneration: z.ZodNumber;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    observedLeaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    observedFenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    reason: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    expectedObjectKey: z.ZodString;
    expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    sizeBytes: z.ZodNumber;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    sizeBytes: number;
    artifactId: string & z.BRAND<"ArtifactId">;
    expectedObjectKey: string;
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    observedLeaseId: string & z.BRAND<"LeaseId">;
    observedFenceToken: string & z.BRAND<"FenceToken">;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    sizeBytes: number;
    artifactId: string;
    expectedObjectKey: string;
    expectedSha256: string;
    targetId: string;
    deviceGeneration: number;
    observedLeaseId: string;
    observedFenceToken: string;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    sizeBytes: number;
    artifactId: string & z.BRAND<"ArtifactId">;
    expectedObjectKey: string;
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    observedLeaseId: string & z.BRAND<"LeaseId">;
    observedFenceToken: string & z.BRAND<"FenceToken">;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    sizeBytes: number;
    artifactId: string;
    expectedObjectKey: string;
    expectedSha256: string;
    targetId: string;
    deviceGeneration: number;
    observedLeaseId: string;
    observedFenceToken: string;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
}>;
export type QuarantineGrantPayloadV1 = z.infer<typeof quarantineGrantPayloadV1Schema>;
/** The issued quarantine PUT grant: ≤5-minute expiry, quarantine-prefixed key. */
export declare const quarantineUploadGrantV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    operation: z.ZodLiteral<"quarantine_upload">;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    method: z.ZodLiteral<"PUT">;
    url: z.ZodString;
    headers: z.ZodRecord<z.ZodString, z.ZodString>;
    issuedAt: z.ZodString;
    expiresAt: z.ZodString;
    maxBytes: z.ZodNumber;
    expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    quarantineObjectKey: z.ZodString;
    redaction: z.ZodLiteral<"secret">;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string & z.BRAND<"ArtifactId">;
    url: string;
    headers: Record<string, string>;
    operation: "quarantine_upload";
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
    quarantineObjectKey: string;
}, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string;
    url: string;
    headers: Record<string, string>;
    operation: "quarantine_upload";
    expectedSha256: string;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
    quarantineObjectKey: string;
}>, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string & z.BRAND<"ArtifactId">;
    url: string;
    headers: Record<string, string>;
    operation: "quarantine_upload";
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
    quarantineObjectKey: string;
}, {
    protocolVersion: 1;
    expiresAt: string;
    artifactId: string;
    url: string;
    headers: Record<string, string>;
    operation: "quarantine_upload";
    expectedSha256: string;
    maxBytes: number;
    method: "PUT";
    issuedAt: string;
    redaction: "secret";
    quarantineObjectKey: string;
}>;
export type QuarantineUploadGrantV1 = z.infer<typeof quarantineUploadGrantV1Schema>;
/**
 * The device-authenticated finalize: after the object is uploaded, verify + record
 * it. Binds the manifest identity (artifact/hash/size/org/job/attempt) to the
 * observed quarantine object. No apply/promote/checkpoint-selection field exists.
 */
export declare const quarantineFinalizePayloadV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    workerId: z.ZodBranded<z.ZodString, "WorkerId">;
    targetId: z.ZodBranded<z.ZodString, "TargetId">;
    deviceGeneration: z.ZodNumber;
    organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
    companyId: z.ZodBranded<z.ZodString, "CompanyId">;
    jobId: z.ZodBranded<z.ZodString, "JobId">;
    attempt: z.ZodNumber;
    observedLeaseId: z.ZodBranded<z.ZodString, "LeaseId">;
    observedFenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    reason: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
    artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
    quarantineObjectKey: z.ZodString;
    expectedSha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
    sizeBytes: z.ZodNumber;
    manifest: z.ZodEffects<z.ZodObject<{
        protocolVersion: z.ZodLiteral<1>;
        organizationId: z.ZodBranded<z.ZodString, "OrganizationId">;
        companyId: z.ZodBranded<z.ZodString, "CompanyId">;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        kind: z.ZodEnum<["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]>;
        sensitivity: z.ZodLiteral<"restricted">;
        retention: z.ZodEnum<["ephemeral", "run", "audit", "checkpoint"]>;
        objectKey: z.ZodString;
        sizeBytes: z.ZodNumber;
        sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        contentType: z.ZodString;
        createdAt: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }>, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }, {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    }>;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    sizeBytes: number;
    artifactId: string & z.BRAND<"ArtifactId">;
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    observedLeaseId: string & z.BRAND<"LeaseId">;
    observedFenceToken: string & z.BRAND<"FenceToken">;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    sizeBytes: number;
    artifactId: string;
    expectedSha256: string;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
    targetId: string;
    deviceGeneration: number;
    observedLeaseId: string;
    observedFenceToken: string;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
}>, {
    protocolVersion: 1;
    jobId: string & z.BRAND<"JobId">;
    attempt: number;
    organizationId: string & z.BRAND<"OrganizationId">;
    companyId: string & z.BRAND<"CompanyId">;
    workerId: string & z.BRAND<"WorkerId">;
    sizeBytes: number;
    artifactId: string & z.BRAND<"ArtifactId">;
    expectedSha256: string & z.BRAND<"Sha256Digest">;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string & z.BRAND<"Sha256Digest">;
        protocolVersion: 1;
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        organizationId: string & z.BRAND<"OrganizationId">;
        companyId: string & z.BRAND<"CompanyId">;
        createdAt: string;
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
    targetId: string & z.BRAND<"TargetId">;
    deviceGeneration: number;
    observedLeaseId: string & z.BRAND<"LeaseId">;
    observedFenceToken: string & z.BRAND<"FenceToken">;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
}, {
    protocolVersion: 1;
    jobId: string;
    attempt: number;
    organizationId: string;
    companyId: string;
    workerId: string;
    sizeBytes: number;
    artifactId: string;
    expectedSha256: string;
    manifest: {
        kind: "workspace_snapshot" | "workspace_patch" | "log" | "screenshot" | "dom_snapshot" | "browser_cookie_state" | "browser_storage_state" | "playwright_trace" | "browser_video" | "download" | "service_checkpoint" | "other";
        sha256: string;
        protocolVersion: 1;
        jobId: string;
        attempt: number;
        organizationId: string;
        companyId: string;
        createdAt: string;
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
        retention: "ephemeral" | "run" | "audit" | "checkpoint";
        objectKey: string;
        contentType: string;
    };
    targetId: string;
    deviceGeneration: number;
    observedLeaseId: string;
    observedFenceToken: string;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
}>;
export type QuarantineFinalizePayloadV1 = z.infer<typeof quarantineFinalizePayloadV1Schema>;
/** The orphan receipt returned after a successful quarantine finalize. Its only
 * disposition is `quarantined` — there is no apply/promote/select disposition. */
export declare const quarantineUploadReceiptV1Schema: z.ZodEffects<z.ZodObject<{
    protocolVersion: z.ZodLiteral<1>;
    receiptId: z.ZodString;
    quarantineObjectKey: z.ZodString;
    observed: z.ZodObject<{
        workerId: z.ZodBranded<z.ZodString, "WorkerId">;
        targetId: z.ZodBranded<z.ZodString, "TargetId">;
        deviceGeneration: z.ZodNumber;
        jobId: z.ZodBranded<z.ZodString, "JobId">;
        attempt: z.ZodNumber;
        leaseId: z.ZodBranded<z.ZodString, "LeaseId">;
        fenceToken: z.ZodBranded<z.ZodString, "FenceToken">;
    }, "strict", z.ZodTypeAny, {
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
    }, {
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        targetId: string;
        deviceGeneration: number;
    }>;
    artifact: z.ZodObject<{
        artifactId: z.ZodBranded<z.ZodString, "ArtifactId">;
        sha256: z.ZodBranded<z.ZodString, "Sha256Digest">;
        sizeBytes: z.ZodNumber;
        sensitivity: z.ZodLiteral<"restricted">;
        provenance: z.ZodEnum<["tracked", "untracked", "generated"]>;
    }, "strict", z.ZodTypeAny, {
        sha256: string & z.BRAND<"Sha256Digest">;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
    }, {
        sha256: string;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
    }>;
    reason: z.ZodEnum<["stale_fence", "late_output", "hash_mismatch", "wrong_prefix", "size_mismatch", "unknown_artifact", "corrupt_checkpoint"]>;
    receivedAt: z.ZodString;
    disposition: z.ZodLiteral<"quarantined">;
}, "strict", z.ZodTypeAny, {
    protocolVersion: 1;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
    receiptId: string;
    observed: {
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
    };
    artifact: {
        sha256: string & z.BRAND<"Sha256Digest">;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
    };
    receivedAt: string;
    disposition: "quarantined";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
    receiptId: string;
    observed: {
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        targetId: string;
        deviceGeneration: number;
    };
    artifact: {
        sha256: string;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
    };
    receivedAt: string;
    disposition: "quarantined";
}>, {
    protocolVersion: 1;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
    receiptId: string;
    observed: {
        jobId: string & z.BRAND<"JobId">;
        attempt: number;
        workerId: string & z.BRAND<"WorkerId">;
        leaseId: string & z.BRAND<"LeaseId">;
        fenceToken: string & z.BRAND<"FenceToken">;
        targetId: string & z.BRAND<"TargetId">;
        deviceGeneration: number;
    };
    artifact: {
        sha256: string & z.BRAND<"Sha256Digest">;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        artifactId: string & z.BRAND<"ArtifactId">;
        sensitivity: "restricted";
    };
    receivedAt: string;
    disposition: "quarantined";
}, {
    protocolVersion: 1;
    reason: "stale_fence" | "late_output" | "hash_mismatch" | "wrong_prefix" | "size_mismatch" | "unknown_artifact" | "corrupt_checkpoint";
    quarantineObjectKey: string;
    receiptId: string;
    observed: {
        jobId: string;
        attempt: number;
        workerId: string;
        leaseId: string;
        fenceToken: string;
        targetId: string;
        deviceGeneration: number;
    };
    artifact: {
        sha256: string;
        provenance: "tracked" | "untracked" | "generated";
        sizeBytes: number;
        artifactId: string;
        sensitivity: "restricted";
    };
    receivedAt: string;
    disposition: "quarantined";
}>;
export type QuarantineUploadReceiptV1 = z.infer<typeof quarantineUploadReceiptV1Schema>;
