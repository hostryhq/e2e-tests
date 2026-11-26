#!/usr/bin/env python3
"""Reads api-specs entities/restaurant/*.yaml and writes src/entities.generated.json: what the projection digest
(sync/protocol-v1.md, `sha256-canon-v1`) needs per entity: owner, day_parent, outside_digest, field names and pii.
Run: python3 -I scripts/gen-entities.py <api-specs>/entities/restaurant > src/entities.generated.json
"""
import glob
import json
import sys

import yaml

out = {}
for p in sorted(glob.glob(sys.argv[1] + "/*.yaml")):
    d = yaml.safe_load(open(p))
    fields = d.get("fields") or {}
    out[d["entity"]] = {
        "owner": d.get("owner"),
        "day_parent": d.get("day_parent"),
        "outside_digest": bool(d.get("outside_digest")),
        "fields": {k: {"pii": bool((v or {}).get("pii"))} for k, v in fields.items()},
        "has_business_date": "business_date" in fields,
        "day_parent_ref": ((fields.get(d.get("day_parent")) or {}).get("ref") if d.get("day_parent") else None),
    }
json.dump(out, sys.stdout, indent=1, sort_keys=True)
print()
