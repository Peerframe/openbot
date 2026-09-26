"""Keep public metadata, exact local pin and runtime declarations consistent."""

from pathlib import Path
import tomllib

root = Path(__file__).resolve().parents[1]
project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
own = [
    s for s in (root / "distribution.lock").read_text().splitlines() if s and not s.startswith("#")
]
assert own == [f"{project['name']}=={project['version']}"], "local artifact version drift"
runtime = [
    s for s in (root / "requirements.txt").read_text().splitlines() if s and not s.startswith("#")
]
assert sorted(runtime) == sorted(project["dependencies"]), "runtime metadata drift"
print(f"Harness metadata matches {own[0]}")
