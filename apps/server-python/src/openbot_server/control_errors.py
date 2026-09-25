"""Stable public failures shared by migrated Owner services; never carries provider/SQL bodies."""
class ControlError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)
