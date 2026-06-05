"""Typed HTTP errors for consistent client-side handling."""

from fastapi import HTTPException, status


class TaktError(HTTPException):
    code: str = "takt_error"

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(status_code=status_code, detail={"code": self.code, "message": message})


class InvalidPAT(TaktError):
    code = "invalid_pat"

    def __init__(self, message: str = "GitHub token is invalid or expired."):
        super().__init__(message, status.HTTP_401_UNAUTHORIZED)


class NotAuthorised(TaktError):
    code = "not_authorised"

    def __init__(self, message: str = "You are not approved to use Takt. Contact an admin."):
        super().__init__(message, status.HTTP_403_FORBIDDEN)


class AdminRequired(TaktError):
    code = "admin_required"

    def __init__(self, message: str = "Admin role required."):
        super().__init__(message, status.HTTP_403_FORBIDDEN)


class NotFound(TaktError):
    code = "not_found"

    def __init__(self, message: str = "Not found."):
        super().__init__(message, status.HTTP_404_NOT_FOUND)


class UpstreamError(TaktError):
    code = "upstream_error"

    def __init__(self, message: str):
        super().__init__(message, status.HTTP_502_BAD_GATEWAY)


class StreamingBufferConflict(TaktError):
    """The target row is still in BigQuery's streaming buffer.

    Returned on the rare path where a session was inserted via the legacy
    streaming API (e.g. by an older server build) and a client tried to
    edit/delete it before the buffer flushed (~30 min). New writes use
    DML INSERT so this should be vanishingly rare going forward.
    """

    code = "streaming_buffer"

    def __init__(
        self,
        message: str = (
            "This session was just written and is still settling in BigQuery. "
            "Try again in a few minutes."
        ),
    ):
        super().__init__(message, status.HTTP_409_CONFLICT)
