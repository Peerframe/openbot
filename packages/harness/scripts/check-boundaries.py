"""Small executable import/size contract; no generated baseline or dependency graph platform."""

from __future__ import annotations
import ast
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
THIRD_PARTY = {"pydantic_ai", "pydantic_core", "jsonschema_rs"}


def imports(source: str, name: str) -> list[str]:
    problems = []
    tree = ast.parse(source, filename=name)
    for node in ast.walk(tree):
        modules = []
        if isinstance(node, ast.Import):
            modules = [item.name for item in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules = [node.module]
        for module in modules:
            top = module.split(".")[0]
            optional = top == "temporalio" and name in {"temporal_agent.py", "sdk_ports.py"}
            if (
                top not in sys.stdlib_module_names | THIRD_PARTY | {"openbot_agent_runtime"}
                and not optional
            ):
                problems.append(f"{name}: forbidden dependency {module}")
        if isinstance(node, ast.Call):
            dynamic = isinstance(node.func, ast.Name) and node.func.id == "__import__"
            dynamic |= isinstance(node.func, ast.Attribute) and node.func.attr in {
                "import_module",
                "spec_from_file_location",
            }
            if dynamic:
                problems.append(f"{name}: dynamic imports require an explicit reviewed boundary")
    return problems


def policy() -> dict:
    return tomllib.loads((ROOT / "pyproject.toml").read_text())["tool"]["openbot"]


def public_exports(module: str = "") -> set[str]:
    source = ROOT / "src/openbot_agent_runtime"
    path = source / (module.replace(".", "/") + ".py") if module else source / "__init__.py"
    if not path.is_file():
        path = source / module.replace(".", "/") / "__init__.py"
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "__all__" for target in node.targets
        ):
            return set(ast.literal_eval(node.value))
    raise ValueError("The harness must declare its public API")


def consumer_imports(source: str, name: str) -> list[str]:
    problems = []
    public = {"openbot_agent_runtime": public_exports()}
    for module in policy()["public-modules"]:
        public[f"openbot_agent_runtime.{module}"] = public_exports(module)
    for node in ast.walk(ast.parse(source, filename=name)):
        modules = []
        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules = [node.module]
            if node.module in public:
                for item in node.names:
                    if (
                        item.name not in public[node.module]
                        and f"{node.module}.{item.name}" not in public
                    ):
                        problems.append(f"{name}: undeclared harness export {item.name}")
        elif isinstance(node, ast.Import):
            modules = [item.name for item in node.names]
        for module in modules:
            if module.startswith("openbot_agent_runtime.") and module not in public:
                problems.append(f"{name}: use public harness exports, not {module}")
    return problems


def sources(root: Path) -> list[Path]:
    # Only declared source roots are traversed. Local environments/build inputs are not source.
    excluded = {"venv", "node_modules", "dist", "build", "__pycache__", "site-packages"}
    return sorted(
        file
        for file in root.rglob("*.py")
        if not any(
            part.startswith(".") or part in excluded for part in file.relative_to(root).parts
        )
    )


def main() -> int:
    exceptions = policy()["review-exceptions"]
    problems = []
    core = ROOT / "src/openbot_agent_runtime"
    files = sources(core)
    for file in files:
        source = file.read_text()
        name = file.relative_to(core).as_posix()
        problems.extend(imports(source, name))
        limit = 300 if name == "contracts.py" else 400
        if name in exceptions:
            exception = exceptions[name]
            if not exception["reason"].strip():
                problems.append(f"{name}: missing concrete review reason")
            limit = exception["maximum-lines"]
        if len(source.splitlines()) > limit:
            problems.append(
                f"{name}: exceeds {limit} reviewed lines; split or review this responsibility"
            )
    for folder in (ROOT / "scripts", ROOT / "examples"):
        for file in sources(folder):
            if len(file.read_text().splitlines()) > 400:
                problems.append(f"{file.relative_to(ROOT)}: exceeds 400 review lines")
    for folder in (
        ROOT / "examples",
        ROOT.parents[1] / "apps/server-python/src/openbot_server",
        ROOT.parents[1] / "apps/server-python/scripts",
    ):
        for file in sources(folder):
            problems.extend(
                consumer_imports(file.read_text(), str(file.relative_to(ROOT.parents[1])))
            )
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"Harness boundaries: {len(files)} modules; real control imports use the public API.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
