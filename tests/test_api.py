import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot.api.server import API
from bot.services.publisher import Publisher
from conftest import signed_init_data


@pytest.fixture
async def client(db, bot):
    publisher = Publisher(bot, db, 0)
    client = TestClient(TestServer(API(db, "test-token", 7, publisher=publisher).app()))
    await client.start_server()
    client.publisher = publisher
    yield client
    await client.close()
    await publisher.close()


async def json_request(client, auth, method, path, body=None, expected=200):
    response = await client.request(method, path, headers=auth, json=body)
    payload = await response.json()
    assert response.status == expected, payload
    return payload


async def test_root_and_static_files_are_packaged_and_private_files_not_served(client):
    for path in ("/", "/index.html"):
        response = await client.get(path)
        assert response.status == 200
        text = await response.text()
        assert 'id="app"' in text and "Index of" not in text
    for path in ("/app.js", "/style.css"):
        response = await client.get(path)
        assert response.status == 200
    for path in ("/.env", "/__init__.py", "/schema.sql", "/bot/config.py"):
        response = await client.get(path)
        assert response.status == 404


@pytest.mark.parametrize(
    "init_data",
    [
        "",
        "invalid",
        signed_init_data(owner_id=8),
        signed_init_data(token="wrong"),
        signed_init_data(auth_date=1),
    ],
)
async def test_owner_authentication(client, init_data):
    response = await client.get(
        "/api/playlists", headers={"X-Telegram-Init-Data": init_data}
    )
    assert response.status == 401
    assert (await response.json())["code"] == "unauthorized"


async def test_playlist_workflow(client, auth, tracks, db, bot):
    created = await json_request(
        client, auth, "POST", "/api/playlists", {"name": "Drive"}, 201
    )
    pid = created["id"]
    channels = await json_request(client, auth, "GET", "/api/channels")
    assert {row["chat_id"] for row in channels} == {-1001, -1002}
    await json_request(
        client,
        auth,
        "PATCH",
        f"/api/playlists/{pid}",
        {"channel_id": -1001, "name": "Driving"},
    )
    results = await json_request(client, auth, "GET", "/api/tracks?q=blue")
    assert [row["id"] for row in results] == [tracks[0]]
    for tid in tracks:
        await json_request(
            client, auth, "POST", f"/api/playlists/{pid}/tracks", {"track_id": tid}
        )
    await json_request(
        client, auth, "POST", f"/api/playlists/{pid}/tracks", {"track_id": tracks[0]}
    )
    await json_request(
        client,
        auth,
        "PUT",
        f"/api/playlists/{pid}/order",
        {"track_ids": list(reversed(tracks))},
    )
    detail = await json_request(client, auth, "GET", f"/api/playlists/{pid}")
    assert [t["id"] for t in detail["tracks"]] == list(reversed(tracks))
    assert detail["latest_job"] is None
    publish = await json_request(
        client, auth, "POST", f"/api/playlists/{pid}/publish", expected=202
    )
    await asyncio.gather(*client.publisher.tasks.values())
    job = await json_request(client, auth, "GET", f"/api/jobs/{publish['job_id']}")
    assert (
        job["status"] == "done" and job["progress"] == 3 and job["skipped_titles"] == []
    )
    assert [call.args[2] for call in bot.copy_message.await_args_list] == [3, 2, 1]
    detail = await json_request(client, auth, "GET", f"/api/playlists/{pid}")
    assert (
        detail["latest_job"]["id"] == publish["job_id"]
        and detail["published_count"] == 3
    )
    await json_request(client, auth, "DELETE", f"/api/playlists/{pid}", expected=409)
    for tid in tracks:
        await json_request(client, auth, "DELETE", f"/api/playlists/{pid}/tracks/{tid}")
    await json_request(
        client, auth, "POST", f"/api/playlists/{pid}/publish", expected=202
    )
    await asyncio.gather(*client.publisher.tasks.values())
    await json_request(client, auth, "DELETE", f"/api/playlists/{pid}")
    await json_request(client, auth, "GET", f"/api/playlists/{pid}", expected=404)
    assert not db.fetchall("SELECT * FROM published_messages")


@pytest.mark.parametrize(
    "body",
    [[], None, 12, {"name": None}, {"name": 123}, {"name": "  "}, {"name": "a" * 101}],
)
async def test_invalid_create_returns_json_400(client, auth, body):
    await json_request(client, auth, "POST", "/api/playlists", body, 400)


@pytest.mark.parametrize(
    "path",
    [
        "/api/tracks?limit=nope",
        "/api/tracks?offset=-1",
        "/api/playlists/nope",
        "/api/jobs/nope",
        "/api/tracks?limit=0",
        "/api/tracks?offset=9999999999999999999999",
        "/api/playlists/9999999999999999999999",
    ],
)
async def test_invalid_query_parameters_return_json_400(client, auth, path):
    await json_request(client, auth, "GET", path, expected=400)


@pytest.mark.parametrize(
    "body",
    [{"track_id": None}, {"track_id": True}, {"track_id": 1.5}, {"track_id": "1"}, {}],
)
async def test_invalid_track_ids(client, auth, playlist, body):
    await json_request(
        client, auth, "POST", f"/api/playlists/{playlist}/tracks", body, 400
    )


@pytest.mark.parametrize(
    "body",
    [
        {"track_ids": [1, 1, 2]},
        {"track_ids": [1, 2]},
        {"track_ids": [True, 2, 3]},
        {"track_ids": None},
        [],
    ],
)
async def test_invalid_reorder_preserves_membership(
    client, auth, playlist, tracks, db, body
):
    await json_request(
        client, auth, "PUT", f"/api/playlists/{playlist}/order", body, 400
    )
    assert [row["id"] for row in db.playlist_tracks(playlist)] == tracks


async def test_mutation_conflicts_and_bad_json(client, auth, playlist, tracks):
    await json_request(
        client, auth, "POST", "/api/playlists", {"name": "Road trip"}, 409
    )
    await json_request(
        client, auth, "PATCH", f"/api/playlists/{playlist}", {"channel_id": -9001}, 422
    )
    response = await client.post("/api/playlists", headers=auth, data="{")
    assert response.status == 400 and (await response.json())["code"] == "invalid_json"
    client.publisher.running.add(playlist)
    for method, path, body in [
        ("PATCH", "", {"name": "Changed"}),
        ("DELETE", "", None),
        ("POST", "/tracks", {"track_id": tracks[0]}),
        ("DELETE", f"/tracks/{tracks[0]}", None),
        ("PUT", "/order", {"track_ids": tracks}),
    ]:
        await json_request(
            client, auth, method, f"/api/playlists/{playlist}{path}", body, 409
        )
    client.publisher.running.clear()


async def test_unknown_api_routes_and_ids_have_consistent_errors(client, auth):
    for path in ("/api/nope", "/api/jobs/999", "/api/playlists/999"):
        payload = await json_request(client, auth, "GET", path, expected=404)
        assert "error" in payload and "code" in payload
