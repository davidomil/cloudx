from .startup import DocumentationService


def create_archive_app():
    from .main import create_app

    return create_app()


app = DocumentationService(create_archive_app)
