from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(HTTPException):
    def __init__(self, status_code: int, detail: str, code: str):
        super().__init__(status_code=status_code, detail=detail)
        self.code = code


async def _handler(request: Request, exc: StarletteHTTPException):
    code = getattr(exc, "code", None) or f"http_{exc.status_code}"
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": code},
        headers=getattr(exc, "headers", None),
    )


def install(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, _handler)
