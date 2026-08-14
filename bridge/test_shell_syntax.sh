#!/usr/bin/env sh
set -eu
python3 - <<'PY'
import ast
ast.parse(open("bridge/modal_bridge.py", encoding="utf-8").read())
PY
python3 - <<'PY' >/tmp/ino-shell-commands.sh
import ast
source = open("bridge/modal_bridge.py", encoding="utf-8").read()
module = ast.parse(source)
functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in {"desktop_command", "agent_command"}]
namespace = {"__name__": "shell_syntax_test"}
exec(compile(ast.Module(body=functions, type_ignores=[]), "bridge/modal_bridge.py", "exec"), namespace)
print(namespace["desktop_command"]())
print(namespace["agent_command"]())
PY
sed -n '1p' /tmp/ino-shell-commands.sh | bash -n -
sed -n '2p' /tmp/ino-shell-commands.sh | bash -n -
rm -f /tmp/ino-shell-commands.sh
