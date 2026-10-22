// Inline every non-commented \input{} / \include{} so the text compiles stand-alone.
// Same regex and path rule as discover() in server.py. No imports: tests run it under plain node.
const INPUT = /\\(?:input|include)\{([^}]+)\}/g;

export function flatten(root: string, texts: Record<string, string>, stack: string[] = []): string {
  const text = texts[root];
  if (text === undefined) return "";
  return text.split("\n").map((line) => {
    const m = /(?<!\\)%/.exec(line);
    const cut = m ? m.index : line.length;
    const code = line.slice(0, cut).replace(INPUT, (whole, name: string) => {
      name = name.trim();
      const rel = name.endsWith(".tex") ? name : name + ".tex";
      if (texts[rel] === undefined || stack.includes(rel) || rel === root) return whole; // missing or cyclic: leave as-is
      return flatten(rel, texts, [...stack, root]).replace(/\n+$/, "");
    });
    return code + line.slice(cut);
  }).join("\n");
}
