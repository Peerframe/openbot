import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Copies the tested example into a new independent project; never overwrites an existing path. */
export async function createMcpPlugin(destination) {
  if (typeof destination !== "string" || !destination.trim())
    throw new Error("Choose a new plugin directory.");
  const directory = resolve(destination);
  await mkdir(directory, { recursive: false });
  for (const name of [
    "plugin-example.ts",
    "plugin-example-view.ts",
    "plugin-compatibility.ts",
    "plugin-preflight.ts",
    "plugin-preflight-fixture.ts",
    "plugin-author-scenarios.ts",
  ])
    await copyFile(join(root, "apps/server/src", name), join(directory, name));
  await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "my-openbot-plugin",
        version: "0.1.0",
        private: true,
        type: "module",
        license: "MIT",
        engines: { node: ">=22.22.2" },
        scripts: {
          start: "tsx plugin-example.ts",
          preflight: "node --import tsx plugin-preflight.ts",
          test: "node --import tsx --test plugin-author-scenarios.ts",
        },
        dependencies: { "@modelcontextprotocol/sdk": "1.30.0", zod: "4.5.4", tsx: "4.23.13" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, ".gitignore"), "node_modules/\n.env\n*.log\n");
  await writeFile(
    join(directory, "README.md"),
    `# My MCP plugin / 我的 MCP 插件

An independent MCP project. No OpenBot source or runtime imports are required.
独立 MCP 项目，运行时不依赖 OpenBot 源码。

1. Run \`npm install\`, then keep the generated package-lock.json in your own repository.
2. Run \`npm test\`: local fixtures cover discovery, schemas, task requirements, bearer authentication, transport/version errors, timeout and result bounds. No OpenBot service, model or external account is needed.
3. Run \`npm start\`. The endpoint is http://127.0.0.1:4318/mcp. In another terminal run \`npm run preflight -- http://127.0.0.1:4318/mcp\` for a read-only tool-profile check of your server.
4. On the OpenBot Server machine, allow that exact endpoint with OPENBOT_PLUGIN_LOCAL_ENDPOINTS and restart the Server. Desktop can inherit it from its launch environment.
5. In Plugins, preview and install it. Grant sum_numbers as read to one Bot, notes://current and ui://notebook/view.html as resources, and review_note as a prompt; then enable it.
6. Ask that Bot to add 13 and 29. Open the notebook view and read its resource. append_note changes demo memory and should use confirm mode.
7. Revoke the grant and confirm access is denied. Change a declaration, preview the update and check the diff. Applying it disables the plugin and clears all grants.

先执行 npm install、npm test，在独立本地环境验证成功与失败场景；再运行 npm start，并在另一终端执行 npm run preflight -- http://127.0.0.1:4318/mcp 检查当前示例的工具声明。测试不需要 OpenBot 服务、模型或外部账号。之后按上述步骤配置 Server 的精确地址白名单，在插件页预览、安装、给指定 Bot 授权并启用。测试工具调用、资源、交互界面、撤权与更新；更新后必须重新授权。

Preflight prints JSON and exits 1 on failure. Its stable \`compatibility\` reason matches OpenBot preview (for example \`schema_unsupported\`, \`authentication_required\`, \`execution_unsupported\`, \`timeout\`). It only accepts exact literal loopback endpoints, does not invoke tools, and does not prove result behavior, resource/prompt compatibility, installation or grants. For an authenticated local server, provide a dedicated test token through OPENBOT_PLUGIN_TEST_TOKEN; never commit it. Generated policy files are a versioned snapshot: regenerate into a new directory to adopt newer OpenBot policy.
预检返回 JSON，失败时退出码为 1；compatibility 字段与 Server 预览一致。它只接受精确的字面量回环地址，不调用工具，也不证明工具结果、资源/提示词、安装和授权可用。本地认证测试通过环境变量 OPENBOT_PLUGIN_TEST_TOKEN 提供专用测试 token，不提交密钥。生成的校验文件是当前版本快照，需要更新规则时生成到新目录比较合入。

Edit plugin-example.ts to add tools/resources/prompts and plugin-example-view.ts for the isolated App. The view can use local interaction and explicitly granted resource reads. Host tool calls, messages, network and devices are not exposed by this profile.
修改两个源码文件即可扩展功能。界面支持本地交互和已授权资源读取；当前宿主不开放界面调用工具、发送消息、外网和设备权限。

The notebook is temporary process memory. Add authentication, persistence and your own backend authorization before public hosting. Preserve license notices; do not add secrets to source or submissions.
示例笔记只存在进程内存。公开托管前完善认证、持久化和后端授权，保留许可声明，不提交密钥。

Full contract: https://github.com/yxflc11/openbot/blob/main/docs/PLUGINS.md
中文手册：https://github.com/yxflc11/openbot/blob/main/docs/PLUGINS.zh-CN.md
`,
  );
  return directory;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: npm run plugin:create -- <new-directory>");
  console.info(await createMcpPlugin(process.argv[2]));
}
