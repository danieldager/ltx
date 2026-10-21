// Frozen wire contract, SPEC §13.2. Additive changes only.

export interface Change { from: number; to: number; insert: string }

export interface WireFile { path: string; text: string; hash: string }

export interface CompileError {
  file: string | null; line: number | null; msg: string; plain: string;
  severity: "error" | "warning";
}

export interface CompileMsg {
  type: "compile"; state: "running" | "ok" | "error"; rev: number;
  pdf_url: string | null; errors: CompileError[]; duration_ms: number | null;
}

export interface IndexMsg {
  type: "index"; labels: Record<string, string>; cites: Record<string, string>;
  macros: Record<string, { nargs: number; body: string }>;
}

export interface Comment {
  id: string; file: string;
  anchor: { quote: string; prefix: string; suffix: string; line: number };
  instruction: string; status: "open" | "done" | "wontdo"; reply: string | null;
  author: string; created_at: string; updated_at: string;
}

export interface Selection {
  file: string; from: number; to: number; line_from: number; line_to: number;
  text: string; paragraph_text: string;
  enclosing: { kind: string; label: string | null; caption: string | null } | null;
}

export type ServerMsg =
  | { type: "hello"; version: 1; root: string; files: WireFile[]; compile: CompileMsg | null;
      index: IndexMsg | null; comments: Comment[] }
  | { type: "saved"; path: string; hash: string }
  | { type: "save_conflict"; path: string; disk_text: string; disk_hash: string }
  | { type: "external"; path: string; base_hash: string; new_hash: string; changes: Change[] }
  | { type: "file"; path: string; text: string; hash: string }
  | { type: "file_added"; file: WireFile }
  | CompileMsg
  | IndexMsg
  | { type: "comments"; comments: Comment[] }
  | { type: "error"; msg: string };

export type ClientMsg =
  | { type: "save"; path: string; base_hash: string; text_hash: string; changes: Change[] }
  | { type: "resync"; path: string }
  | { type: "compile_now" }
  | ({ type: "selection" } & Selection)
  | { type: "comment_add"; comment: Partial<Comment> }
  | { type: "comment_update"; id: string; fields: Partial<Comment> }
  | { type: "comment_delete"; id: string };
