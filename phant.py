#!/usr/bin/env python3
import os, asyncio

try:
    from dotenv import load_dotenv, find_dotenv  # type: ignore
    from pathlib import Path
    _ENV_CANDIDATE = os.environ.get('ENV_PATH')
    if _ENV_CANDIDATE:
        load_dotenv(dotenv_path=_ENV_CANDIDATE, override=True)
    else:
        _FOUND = find_dotenv(usecwd=True)
        if _FOUND:
            load_dotenv(dotenv_path=_FOUND, override=True)
        load_dotenv(dotenv_path=Path(__file__).resolve().parent / '.env', override=False)
        load_dotenv(dotenv_path=Path.home() / '.env', override=False)
except Exception:
    try:
        from pathlib import Path
        def _load_env_file(p: 'Path') -> None:
            if not p.exists():
                return
            try:
                for line in p.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
            except Exception:
                pass
        _load_env_file(Path.cwd() / '.env')
        _load_env_file(Path(__file__).resolve().parent / '.env')
        _load_env_file(Path.home() / '.env')
    except Exception:
        pass

if __name__ == '__main__':
    from core.runner import main as _main
    asyncio.run(_main())
