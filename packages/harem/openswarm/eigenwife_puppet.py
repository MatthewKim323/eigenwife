"""Eigenwife harem puppet routes for Open Swarm.

Lets an outside orchestrator (jabby / eigenwife harem) drive agent cards
without Open Swarm running its own agent loop. Sessions are launched idle via
POST /api/agents/launch (no prompt), then fed status + messages here.

Install: copy into backend/apps/agents/ and add
    from backend.apps.agents import eigenwife_puppet  # noqa: F401
at the bottom of backend/apps/agents/agents.py (see apply.sh).
"""

from typing import Any, Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.agents import agents
from backend.apps.agents.core.models import Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import save_session


class PuppetMessage(BaseModel):
    role: Literal["user", "assistant", "tool_call", "tool_result", "system", "thinking"]
    content: Any


class PuppetPlace(BaseModel):
    x: float
    y: float


class PuppetBody(BaseModel):
    status: Optional[Literal["running", "waiting_approval", "completed", "error", "stopped"]] = None
    name: Optional[str] = None
    message: Optional[PuppetMessage] = None
    place: Optional[PuppetPlace] = None


@agents.router.post("/sessions/{session_id}/puppet")
async def puppet(session_id: str, body: PuppetBody):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if body.name is not None:
        session.name = body.name

    if body.message is not None:
        msg = Message(role=body.message.role, content=body.message.content, branch_id=session.active_branch_id)
        session.messages.append(msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": msg.model_dump(mode="json"),
        })

    if body.status is not None or body.name is not None:
        if body.status is not None:
            session.status = body.status
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": session.status,
            "session": session.model_dump(mode="json"),
        })

    if body.place is not None:
        await ws_manager.broadcast_global("apps_sdk:place_agent_card", {
            "session_id": session_id, "x": body.place.x, "y": body.place.y,
        })

    # Save just this session. persist_all_sessions is the shutdown flush: it stops and evicts everything.
    doc = session.model_dump(mode="json")
    doc["search_text"] = agent_manager.build_search_text(session)
    save_session(session_id, doc)
    return {"ok": True}
