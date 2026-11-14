#!/usr/bin/env python3
"""
Pacior AST & Dependency Analyzer
Fast, non-blocking AST extractor and dependency analyzer for Python codebases.
Outputs JSON containing symbols (classes, functions, decorators, line ranges) and imports.
"""

import ast
import json
import os
import sys

def analyze_python_file(filepath, relpath):
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            code = f.read()
    except Exception as e:
        return {"file": relpath, "error": str(e), "symbols": [], "imports": []}

    try:
        tree = ast.parse(code, filename=filepath)
    except SyntaxError as e:
        return {"file": relpath, "error": f"SyntaxError: {e}", "symbols": [], "imports": []}

    symbols = []
    imports = []
    
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({
                    "module": alias.name,
                    "asname": alias.asname,
                    "is_from": False,
                    "line": node.lineno
                })
        elif isinstance(node, ast.ImportFrom):
            mod = ("." * node.level) + (node.module or "")
            for alias in node.names:
                imports.append({
                    "module": mod,
                    "name": alias.name,
                    "asname": alias.asname,
                    "is_from": True,
                    "line": node.lineno
                })
        elif isinstance(node, ast.FunctionDef) or isinstance(node, getattr(ast, "AsyncFunctionDef", ())):
            args = [a.arg for a in node.args.args]
            doc = ast.get_docstring(node)
            symbols.append({
                "type": "function",
                "name": node.name,
                "start_line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "args": args,
                "docstring": doc[:200] if doc else None,
                "decorators": [ast.unparse(d) if hasattr(ast, "unparse") else d.__class__.__name__ for d in node.decorator_list]
            })
        elif isinstance(node, ast.ClassDef):
            class_methods = []
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, getattr(ast, "AsyncFunctionDef", ()))):
                    class_methods.append({
                        "name": item.name,
                        "start_line": item.lineno,
                        "end_line": getattr(item, "end_lineno", item.lineno),
                        "args": [a.arg for a in item.args.args]
                    })
            doc = ast.get_docstring(node)
            symbols.append({
                "type": "class",
                "name": node.name,
                "start_line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
                "methods": class_methods,
                "bases": [ast.unparse(b) if hasattr(ast, "unparse") else b.__class__.__name__ for b in node.bases],
                "docstring": doc[:200] if doc else None
            })

    return {
        "file": relpath,
        "line_count": len(code.splitlines()),
        "symbols": symbols,
        "imports": imports
    }

def scan_repository(root_dir, target_files=None):
    results = {}
    ignored = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache", ".pacior"}
    
    if target_files:
        files_to_scan = target_files
    else:
        files_to_scan = []
        for dirpath, dirnames, filenames in os.walk(root_dir):
            dirnames[:] = [d for d in dirnames if d not in ignored]
            for f in filenames:
                if f.endswith(".py") or f.endswith(".ts") or f.endswith(".js"):
                    files_to_scan.append(os.path.join(dirpath, f))

    for fpath in files_to_scan:
        rel = os.path.relpath(fpath, root_dir).replace("\\", "/")
        if fpath.endswith(".py"):
            results[rel] = analyze_python_file(fpath, rel)
            
    return results

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing workspace path"}))
        sys.exit(1)
        
    workspace_root = sys.argv[1]
    targets = sys.argv[2:] if len(sys.argv) > 2 else None
    data = scan_repository(workspace_root, targets)
    print(json.dumps(data))

