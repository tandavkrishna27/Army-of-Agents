import path from "node:path";

/**
 * Static extension → MIME type map for common file types.
 * Avoids adding external mime-type dependency.
 */
const EXTENSION_MAP: Record<string, string> = {
  // Code
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "application/javascript",
  ".jsx": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".json": "application/json",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".scala": "text/x-scala",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".ps1": "text/x-powershell",
  ".sql": "application/sql",

  // Web
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".less": "text/x-less",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",

  // Markup / docs
  ".md": "text/markdown",
  ".mdx": "text/mdx",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".log": "text/plain",

  // Config
  ".gitignore": "text/plain",
  ".editorconfig": "text/plain",
  ".prettierrc": "application/json",
  ".eslintrc": "application/json",
  ".dockerignore": "text/plain",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",

  // Documents
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",

  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",

  // Data
  ".wasm": "application/wasm",
  ".proto": "text/x-protobuf",
  ".graphql": "text/x-graphql",
  ".gql": "text/x-graphql",
};

/**
 * Returns the MIME content type for a filename based on its extension.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
export function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_MAP[ext] ?? "application/octet-stream";
}
