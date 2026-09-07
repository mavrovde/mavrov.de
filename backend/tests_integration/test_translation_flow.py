"""Transparent translation (#248) through the COMPOSED stack (rule 12).

The unit tier mocks `_generate`; this tier runs the real background task
against the WireMock `ollama` service — the full path intake → task → own
session → LLM HTTP call → row update, over real HTTP. The
`ollama-generate-translation.json` mapping answers any prompt containing
"precise translation service" with a translation-shaped JSON; every other
generate call keeps the generic prose stub.
"""

import time

import httpx

from conftest import API


def _poll_translated(
    client: httpx.Client,
    headers: dict[str, str],
    interaction_id: str,
    timeout_s: float = 15.0,
) -> dict:
    """The task is backgrounded; poll the admin list until it lands."""
    deadline = time.monotonic() + timeout_s
    row: dict = {}
    while time.monotonic() < deadline:
        page = client.get(
            f"{API}/admin/interactions?page_size=50", headers=headers
        ).json()
        row = next(i for i in page["items"] if i["id"] == interaction_id)
        if row["translation_status"] in ("done", "failed", "not_needed"):
            return row
        time.sleep(0.5)
    return row


def test_contact_message_is_translated_end_to_end(client, admin_headers):
    created = client.post(
        f"{API}/interactions/contact",
        json={
            "name": "Ilse Integration",
            "email": "ilse@agency.example",
            "message": "Hallo, sind Sie offen für eine neue Stelle? [inttest]",
        },
    )
    assert created.status_code == 201, created.text

    row = _poll_translated(client, admin_headers, created.json()["id"])
    # Original untouched; translation in separate fields, from the stub.
    assert row["message"] == "Hallo, sind Sie offen für eine neue Stelle? [inttest]"
    assert row["translation_status"] == "done", row
    assert row["detected_language"] == "de"
    assert row["translated_message"] == "Hello, are you open to a new role? [wiremock]"


def test_rerun_endpoint_requires_admin_and_works_with_it(client, admin_headers):
    created = client.post(
        f"{API}/interactions/contact",
        json={
            "name": "Norbert NoAuth",
            "email": "norbert@agency.example",
            "message": "Guten Tag, hätten Sie Interesse? [inttest-rerun]",
        },
    )
    assert created.status_code == 201, created.text
    interaction_id = created.json()["id"]

    # #298 review blocker 1, verified at the composed layer: anonymous rerun
    # is refused before the handler can act as an id oracle or spend tokens.
    anon = client.post(f"{API}/admin/interactions/{interaction_id}/translate")
    assert anon.status_code == 401, anon.text

    authed = client.post(
        f"{API}/admin/interactions/{interaction_id}/translate",
        headers=admin_headers,
    )
    assert authed.status_code == 200, authed.text
    assert authed.json()["translation_status"] == "pending"

    row = _poll_translated(client, admin_headers, interaction_id)
    assert row["translation_status"] == "done"
    assert row["message"] == "Guten Tag, hätten Sie Interesse? [inttest-rerun]"
