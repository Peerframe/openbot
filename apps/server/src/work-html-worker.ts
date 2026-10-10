/** Extracts bounded public-page text inside the restricted parser child process. */
import { Parser } from "htmlparser2";

const limit = 512 * 1024;
const omitted = new Set(["script", "style", "iframe", "noscript", "img", "template"]);
async function main() {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) throw new Error();
    chunks.push(chunk);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const stack = [{ hidden: false, children: 0 }],
    output: string[] = [];
  let nodes = 0,
    textNode = "",
    outputBytes = 0;
  const node = () => {
    if (++nodes > 50000 || ++stack.at(-1)!.children > 1000) throw new Error();
  };
  const flush = () => {
    if (!textNode) return;
    node();
    const part = textNode.trim();
    textNode = "";
    if (!stack.at(-1)!.hidden && part) {
      outputBytes += Buffer.byteLength(part) + 1;
      if (outputBytes > 4 * 1024 * 1024) throw new Error();
      output.push(part);
    }
  };
  const parser = new Parser(
    {
      onopentag(name) {
        flush();
        node();
        stack.push({ hidden: stack.at(-1)!.hidden || omitted.has(name), children: 0 });
        if (stack.length > 41) throw new Error();
      },
      onclosetag() {
        flush();
        if (stack.length > 1) stack.pop();
      },
      ontext(value) {
        textNode += value;
      },
      oncomment() {
        flush();
        node();
      },
      onprocessinginstruction() {
        flush();
        node();
      },
      onend() {
        flush();
      },
    },
    { xmlMode: false, decodeEntities: true },
  );
  parser.end(text);
  process.stdout.write(output.join("\n"));
}
main().catch(() => {
  process.exitCode = 2;
});
