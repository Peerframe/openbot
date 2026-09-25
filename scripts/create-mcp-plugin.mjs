import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Copies the tested example into a new independent project; never overwrites an existing path. */
export async function createMcpPlugin(destination) {
  if (typeof destination !== "string" || !destination.trim())
    throw new Error("Choose a new plugin directory.");
  const directory = resolve(destination);
  await mkdir(directory, { recursive: false });
  for (const name of ["plugin-example.ts", "plugin-example-view.ts"])
    await copyFile(join(root, "packages/mcp-example/src", name), join(directory, name));
  await copyFile(join(root, "packages/mcp-example/LICENSE"), join(directory, "LICENSE"));
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
        scripts: { start: "tsx plugin-example.ts" },
        dependencies: { "@modelcontextprotocol/sdk": "1.30.0", zod: "4.6.2", tsx: "4.23.13" },
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
2. Run \`npm start\`. The endpoint is http://127.0.0.1:4318/mcp.
3. On the OpenBot Server machine, allow that exact endpoint and restart. The legacy Server uses OPENBOT_PLUGIN_LOCAL_ENDPOINTS=http://127.0.0.1:4318/mcp; the explicit Python product entry uses OPENBOT_CONTROL_PLUGIN_LOCAL_ENDPOINTS=["http://127.0.0.1:4318/mcp"] as a JSON array. Configure the selected entry; these are not implicit aliases.
4. In Plugins, preview and install it. Grant sum_numbers as read to one Bot, notes://current and ui://notebook/view.html as resources, and review_note as a prompt; then enable it.
5. Ask that Bot to add 13 and 29. Open the notebook view and read its resource. append_note changes demo memory and should use confirm mode.
6. Revoke the grant and confirm access is denied. Change a declaration, preview the update and check the diff. Applying it disables the plugin and clears all grants.

依次执行 npm install、npm start，再按上述步骤配置所选 Server 入口的精确地址白名单（Python product 使用 JSON 数组，旧 Server 使用原变量），在插件页预览、安装、给指定 Bot 授权并启用。测试工具调用、资源、交互界面、撤权与更新；更新后必须重新授权。

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
