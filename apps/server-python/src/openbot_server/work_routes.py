"""One Owner-facing work API for headless, Web and Desktop clients."""
from urllib.parse import quote
from fastapi import FastAPI, HTTPException, Path, Request
from fastapi.responses import Response
from pydantic import ValidationError

from .auth_routes import validate_origins
from .authority import AuthenticationRequired
from .http_input import authorize_owner, read_json
from .work_models import CreateTask, DecideAction, EmptyCommand, WorkSnapshot
from .work_values import InvalidWork, WorkConflict, WorkNotFound


def register_work_routes(app: FastAPI, writer, read_store, *, secure_cookies, allowed_origins):
    validate_origins(allowed_origins)
    cookie_name = '__Host-openbot_session' if secure_cookies else 'openbot_session'

    async def write_input(request, model, limit):
        token = await authorize_owner(request, read_store, cookie_name=cookie_name,
                                      allowed_origins=allowed_origins)
        try:
            return token, model.model_validate(await read_json(request, max_bytes=limit))
        except ValidationError:
            raise HTTPException(422, 'Invalid work command.') from None

    async def result(operation):
        try:
            return await operation
        except AuthenticationRequired:
            raise HTTPException(401, 'Authentication required.') from None
        except WorkNotFound:
            raise HTTPException(404, 'Work item not found.') from None
        except WorkConflict as error:
            raise HTTPException(409, str(error)) from None
        except InvalidWork:
            raise HTTPException(422, 'Invalid work command.') from None

    def schema(model):
        return {'requestBody': {'required': True, 'content': {'application/json': {'schema': model.model_json_schema()}}}}

    @app.post('/api/v1/tasks', response_model=WorkSnapshot, status_code=202,
              operation_id='createWorkTask', openapi_extra=schema(CreateTask))
    async def create(request: Request):
        token, body = await write_input(request, CreateTask, 20000)
        return await result(writer.create(token, bot_id=body.botId, objective=body.objective,
                                         token_limit=body.tokenLimit, request_key=body.requestKey))

    @app.get('/api/v1/tasks/{task_id}', response_model=WorkSnapshot, operation_id='getWorkTask')
    async def read(request: Request, task_id: str = Path(min_length=1, max_length=128)):
        return await result(writer.snapshot(request.cookies.get(cookie_name), task_id))

    @app.post('/api/v1/tasks/{task_id}/cancel', response_model=WorkSnapshot,
              operation_id='cancelWorkTask', openapi_extra=schema(EmptyCommand))
    async def cancel(request: Request, task_id: str = Path(min_length=1, max_length=128)):
        token, _ = await write_input(request, EmptyCommand, 128)
        return await result(writer.cancel(token, task_id))

    @app.post('/api/v1/actions/{action_id}/decision', response_model=WorkSnapshot,
              operation_id='decideWorkAction', openapi_extra=schema(DecideAction))
    async def decide(request: Request, action_id: str = Path(min_length=1, max_length=128)):
        token, body = await write_input(request, DecideAction, 512)
        return await result(writer.decide(token, action_id, intent_digest=body.intentDigest, approved=body.approved))

    @app.get('/api/v1/artifacts/{artifact_id}', operation_id='downloadWorkArtifact', response_class=Response)
    async def download(request: Request, artifact_id: str = Path(min_length=1, max_length=128)):
        artifact, data = await result(writer.download(request.cookies.get(cookie_name),artifact_id))
        return Response(data,media_type=artifact['media_type'],headers={
            'Content-Disposition': "attachment; filename*=UTF-8''"+quote(artifact['name'],safe=''),
            'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'none'; sandbox"})
