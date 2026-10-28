from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl


class AuthError(ValueError):
    pass


def verify_init_data(
    init_data: str, bot_token: str, owner_id: int, max_age: int = 86400
) -> dict[str, str]:
    if not init_data:
        raise AuthError("missing init data")
    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    received = fields.pop("hash", "")
    if not received:
        raise AuthError("missing hash")
    check_string = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received):
        raise AuthError("invalid hash")
    try:
        auth_date = int(fields.get("auth_date", "0"))
        user_id = int(json.loads(fields.get("user", "{}"))["id"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise AuthError("invalid user data") from exc
    if (
        auth_date <= 0
        or time.time() - auth_date > max_age
        or auth_date > time.time() + 60
    ):
        raise AuthError("expired init data")
    if user_id != owner_id:
        raise AuthError("unauthorized user")
    fields["user_id"] = str(user_id)
    return fields
