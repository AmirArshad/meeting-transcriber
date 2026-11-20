"""Extract a pinned standalone Python archive with strict paths and data filtering."""
import re
import sys
import tarfile

if not hasattr(tarfile, "data_filter"):
    raise RuntimeError("Build Python must provide tarfile.data_filter; update Python 3.11")

def safe_member(member, destination):
    name = member.name
    if ("\0" in name or name.startswith(("/", "\\"))
            or re.match(r"^[a-zA-Z]:", name)
            or ".." in name.replace("\\", "/").split("/")):
        raise tarfile.FilterError(f"Refusing unsafe tar archive entry path: {name}")
    return tarfile.data_filter(member, destination)

with tarfile.open(sys.argv[1], "r:gz") as archive:
    archive.extractall(sys.argv[2], filter=safe_member)
