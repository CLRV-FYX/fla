"""FLA - 安全模块: bcrypt 密码哈希 + JWT 令牌"""
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
import jwt

from .db import DATA

_secret = None


def secret() -> str:
    global _secret
    if _secret is None:
        f = DATA / "secret.key"
        if f.exists():
            _secret = f.read_text().strip()
        else:
            _secret = secrets.token_hex(32)
            try:
                f.write_text(_secret)
            except Exception:
                pass
    return _secret


def hash_password(pw: str) -> str:
    if len(pw.encode("utf-8")) > 72:
        raise ValueError("密码过长")
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode())
    except Exception:
        return False


def make_token(user) -> str:
    payload = {
        "sub": str(user["id"]),
        "role": user["role"],
        "exp": datetime.now(timezone.utc) + timedelta(days=14),
    }
    return jwt.encode(payload, secret(), algorithm="HS256")


def decode_token(token: str):
    try:
        return jwt.decode(token, secret(), algorithms=["HS256"])
    except Exception:
        return None
