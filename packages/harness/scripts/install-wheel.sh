#!/bin/sh
# The caller owns the environment. Install only this local wheel; never resolve from an index.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
python_bin=$1
"$python_bin" -I "$here/scripts/check-metadata.py"
wheel=$("$python_bin" -I -c 'import pathlib,sys,tomllib; p=pathlib.Path(sys.argv[1]); m=tomllib.loads((p/"pyproject.toml").read_text())["project"]; print(p/"dist"/(m["name"].replace("-","_")+"-"+m["version"]+"-py3-none-any.whl"))' "$here")
test -f "$wheel"
"$python_bin" -I -m pip --isolated install --no-index --no-deps --force-reinstall "$wheel"
