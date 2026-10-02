"""Stable public failures shared by migrated Owner services; never carries provider/SQL bodies."""
class ControlError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


class AttachmentReferenceConflict(ControlError):
    """Only bounded counts, never messages or task content, accompany this refusal."""
    def __init__(self, counts):
        super().__init__(409, 'attachment_referenced')
        self.reference_count = dict(messages=counts['messages'], tasks=counts['tasks'])
