"""Schema-two archive admission and transfer of durable job history."""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path

import numpy as np


class InvalidPortableCatalog(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidPortableCatalog(message)


def json_value(encoded, kind, label):
    try:
        value = json.loads(encoded, parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)))
    except (ValueError, TypeError) as error:
        raise InvalidPortableCatalog(f'{label} must contain valid finite JSON.') from error
    require(isinstance(value, kind), f'{label} must contain a JSON {kind.__name__}.')
    return value


def digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def revision(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{32}', value) is not None


def validate_catalog_records(db):
    from .enrichment_runs import EnrichmentRuns, EnrichmentRunError, valid_run_id

    require(db.execute('PRAGMA user_version').fetchone()[0] == 2, 'Portable catalogs require schema version 2; upgrade and rebuild the original archive before export.')
    require(db.execute('PRAGMA foreign_key_check').fetchone() is None, 'Portable catalog contains orphaned foreign-key records.')
    primary_keys = {'documents': ['document_id'], 'chunks': ['chunk_id'], 'document_enrichments': ['enrichment_id'],
                    'enrichment_runs': ['run_id'], 'enrichment_batches': ['run_id', 'batch_index'],
                    'document_artifacts': ['document_id', 'extraction_revision', 'artifact_id'],
                    'embedding_cache': ['profile_id', 'text_sha256'], 'media_evidence': ['run_id', 'input_sha256'],
                    'media_completion': ['run_id'], 'source_checks': ['check_id'], 'purge_events': ['purge_id'],
                    'reanalysis_campaigns': ['campaign_id'], 'reanalysis_items': ['campaign_id', 'document_id'], 'archive_state': ['state_id']}
    for table, expected in primary_keys.items():
        columns = sorted((row for row in db.execute(f'PRAGMA table_info({table})') if row['pk']), key=lambda row: row['pk'])
        require([row['name'] for row in columns] == expected, f'{table} has an invalid durable identity key.')
    foreign_keys = {**{table: ('document_id', 'documents', 'document_id', 'CASCADE') for table in
                      ['chunks', 'document_enrichments', 'document_enrichment_outcomes', 'document_artifacts', 'enrichment_runs']},
                    **{table: ('run_id', 'enrichment_runs', 'run_id', 'CASCADE') for table in
                      ['enrichment_batches', 'media_evidence', 'media_completion']},
                    'reanalysis_items': ('campaign_id', 'reanalysis_campaigns', 'campaign_id', 'CASCADE')}
    for table, expected in foreign_keys.items():
        actual = {(row['from'], row['table'], row['to'], row['on_delete']) for row in db.execute(f'PRAGMA foreign_key_list({table})')}
        require(actual == {expected}, f'{table} must declare its source ownership and cascade foreign key.')
    require(db.execute('SELECT COUNT(*) FROM archive_state').fetchone()[0] == 1 and db.execute('SELECT 1 FROM archive_state WHERE state_id=1').fetchone(), 'Catalog requires one authoritative archive state row.')
    document_states = {'active', 'stale', 'deleted', 'revoked', 'quarantined', 'superseded'}
    run_states = {'running', 'complete', 'failed', 'cancelled', 'skipped', 'interrupted', 'obsolete'}
    for row in db.execute('SELECT * FROM documents'):
        require(revision(row['extraction_revision']), 'Archive import contains invalid extraction revisions.')
        require(row['state'] in document_states and digest(row['content_sha256']), 'Invalid document state or source identity.')
        require(isinstance(row['source_key'], str) and bool(row['source_key'].strip()), 'Document source key is required.')
        tags = json_value(row['tags_json'], list, 'Document tags')
        require(all(isinstance(tag, str) for tag in tags), 'Document tags must be strings.')
        manifest = json_value(row['source_manifest_json'], dict, 'Source manifest')
        require(manifest.get('schemaVersion') == 2 and manifest.get('mode') in {'file', 'text', 'html', 'generated-code', 'retained-evidence', 'legacy-generated-documentation'}, 'Source manifest has an unsupported schema or mode.')
        original = manifest.get('original')
        require(isinstance(original, dict) and original.get('path') == row['snapshot_path'] and original.get('sha256') == row['content_sha256'] and isinstance(original.get('filename'), str), 'Source manifest original identity does not match its document.')
        require(isinstance(manifest.get('metadata'), dict) and isinstance(manifest.get('processor'), dict), 'Source manifest requires metadata and processor objects.')
        require(digest(row['processor_fingerprint']) or row['processor_fingerprint'] == '' and manifest.get('analysisNeedsRebuild') is True, 'Source processor fingerprint is missing or invalid.')
        if row['processor_fingerprint']:
            require(hashlib.sha256(json.dumps(manifest['processor'], sort_keys=True).encode()).hexdigest() == row['processor_fingerprint'], 'Source processor fingerprint does not match its declared dependencies.')
    for row in db.execute('SELECT * FROM enrichment_runs'):
        require(valid_run_id(row['run_id']), 'Invalid enrichment run identity; a generated run ID is required.')
        require(row['status'] in run_states and revision(row['extraction_revision']) and digest(row['processor_fingerprint']), 'Invalid enrichment run identity or state.')
        require(isinstance(row['lease_until'], (int, float)) and math.isfinite(row['lease_until']) and row['lease_until'] >= 0, 'Invalid enrichment lease deadline.')
        require(isinstance(row['lease_token'], str) and len(row['lease_token']) == 64 and isinstance(row['owner_id'], str) and bool(row['owner_id'].strip()), 'Invalid enrichment lease identity.')
        if row['result_json'] is not None:
            json_value(row['result_json'], dict, 'Enrichment result')
        current = db.execute('SELECT extraction_revision FROM documents WHERE document_id = ?', (row['document_id'],)).fetchone()
        require(current is not None and (row['status'] == 'obsolete' or current[0] == row['extraction_revision']), 'Enrichment run belongs to a different source revision.')
    orphan = db.execute('SELECT 1 FROM chunks c LEFT JOIN documents d ON c.document_id=d.document_id LEFT JOIN enrichment_runs r ON c.run_id=r.run_id LEFT JOIN document_enrichments e ON c.enrichment_id=e.enrichment_id WHERE d.document_id IS NULL OR (c.run_id IS NOT NULL AND (r.run_id IS NULL OR r.document_id != c.document_id)) OR (c.enrichment_id IS NOT NULL AND (e.enrichment_id IS NULL OR e.document_id != c.document_id)) LIMIT 1').fetchone()
    require(orphan is None, 'Chunk references missing or unrelated source, run or enrichment records.')
    supports = EnrichmentRuns(None)
    for row in db.execute('SELECT c.*,d.extraction_revision,d.state AS document_state FROM chunks c JOIN documents d USING(document_id)'):
        require(row['chunk_origin'] in {'source', 'ai', 'media'} and row['state'] in document_states | {'pending'}, 'Invalid chunk origin or state.')
        require(row['state'] != 'active' or row['document_state'] == 'active', 'Active chunk belongs to an inactive document.')
        anchors = json_value(row['support_json'], list, 'Chunk support anchors')
        if row['chunk_origin'] == 'ai':
            run = db.execute('SELECT * FROM enrichment_runs WHERE run_id = ?', (row['run_id'],)).fetchone()
            require(run is not None and run['status'] == 'complete' and run['extraction_revision'] == row['extraction_revision'] and anchors, 'AI chunks require a completed current run and source support.')
            try:
                for anchor in anchors:
                    supports._support(db, run, anchor)
            except EnrichmentRunError as error:
                raise InvalidPortableCatalog(str(error)) from error
        elif row['chunk_origin'] == 'source':
            require(row['run_id'] is None and row['enrichment_id'] is None and not anchors, 'Source chunks cannot claim derived run ownership.')
        else:
            require(row['run_id'] is not None, 'Media chunks require retained run ownership.')
    for row in db.execute('SELECT * FROM document_enrichments'):
        json_value(row['skill_ids_json'], list, 'Enrichment skills')
        json_value(row['payload_json'], dict, 'Enrichment payload')
        if row['run_id'] is not None:
            run = db.execute('SELECT document_id,extraction_revision FROM enrichment_runs WHERE run_id = ?', (row['run_id'],)).fetchone()
            require(run is not None and tuple(run) == (row['document_id'], row['extraction_revision']), 'Enrichment record does not match its run.')
    for row in db.execute('SELECT * FROM document_artifacts'):
        payload = json_value(row['payload_json'], dict, 'Artifact registry payload')
        require(payload.get('id') == row['artifact_id'] and payload.get('locator') == row['locator'] and payload.get('documentId') == row['document_id'], 'Artifact registry identity does not match its payload.')
        require(isinstance(payload.get('type'), str), 'Artifact registry requires a declared artifact type.')
        require(isinstance(row['ordinal'], int) and row['ordinal'] >= 0 and revision(row['extraction_revision']), 'Invalid artifact ordinal or source revision.')
        document = db.execute('SELECT extraction_revision FROM documents WHERE document_id = ?', (row['document_id'],)).fetchone()
        require(document is not None and document[0] == row['extraction_revision'], 'Artifact registry belongs to an unavailable source revision.')
        if row['run_id'] is not None:
            run = db.execute('SELECT document_id,extraction_revision FROM enrichment_runs WHERE run_id = ?', (row['run_id'],)).fetchone()
            require(run is not None and tuple(run) == (row['document_id'], row['extraction_revision']), 'Artifact registry belongs to another run or revision.')
    for row in db.execute('SELECT b.*,r.status,r.document_id,r.extraction_revision FROM enrichment_batches b JOIN enrichment_runs r USING(run_id)'):
        require(isinstance(row['batch_index'], int) and 0 <= row['batch_index'] < 100000 and digest(row['input_fingerprint']) and isinstance(row['model'], str) and 0 < len(row['model']) <= 200, 'Invalid enrichment checkpoint identity.')
        output = json_value(row['output_json'], dict, 'Enrichment checkpoint')
        if row['status'] != 'obsolete':
            try:
                supports._validate_output(db, row, output)
            except EnrichmentRunError as error:
                raise InvalidPortableCatalog(str(error)) from error
        else:
            require(isinstance(output.get('spans'), list), 'Obsolete checkpoint requires retained span records.')
    for table, column in [('media_evidence', 'result_json'), ('media_completion', 'metadata_json'), ('source_checks', 'details_json')]:
        for row in db.execute(f'SELECT {column} FROM {table}'):
            json_value(row[0], dict, table)
    for row in db.execute('SELECT m.*,r.document_id,r.status FROM media_evidence m JOIN enrichment_runs r USING(run_id)'):
        require(digest(row['input_sha256']), 'Invalid retained media input identity.')
        result = json_value(row['result_json'], dict, 'Retained media result')
        require(isinstance(result.get('chunks'), list) and isinstance(result.get('artifacts'), list), 'Retained media result requires chunk and artifact lists.')
        if row['status'] != 'obsolete':
            for chunk in result['chunks']:
                require(isinstance(chunk, dict), 'Retained media chunk must be an object.')
                retained = db.execute("SELECT locator,text FROM chunks WHERE chunk_id=? AND document_id=? AND run_id=? AND chunk_origin='media'", (chunk.get('chunk_id'), row['document_id'], row['run_id'])).fetchone()
                require(retained is not None and tuple(retained) == (chunk.get('locator'), chunk.get('text')), 'Retained media result references unrelated chunk evidence.')
    for row in db.execute('SELECT * FROM embedding_cache'):
        payload = row['vector']
        require(digest(row['text_sha256']) and digest(row['vector_sha256']) and isinstance(row['profile_id'], str), 'Invalid cached embedding identity.')
        require(isinstance(row['dimensions'], int) and 0 < row['dimensions'] <= 16384 and isinstance(payload, bytes) and len(payload) == row['dimensions'] * 4, 'Invalid cached embedding dimensions.')
        require(hashlib.sha256(payload).hexdigest() == row['vector_sha256'] and np.isfinite(np.frombuffer(payload, dtype='<f4')).all(), 'Cached embedding failed integrity validation.')
    for row in db.execute('SELECT * FROM reanalysis_campaigns'):
        require(row['status'] in {'queued', 'running', 'complete', 'failed', 'cancelled', 'interrupted'}, 'Invalid reanalysis campaign state.')
    for row in db.execute('SELECT * FROM reanalysis_items'):
        require(row['status'] in {'pending', 'running', 'complete', 'failed', 'interrupted'} and revision(row['expected_revision']), 'Invalid captured reanalysis item.')
    for row in db.execute('SELECT * FROM source_checks'):
        require(row['status'] in {'unchanged', 'known-revision', 'new-revision', 'refreshed'} and digest(row['content_sha256']), 'Invalid source check result.')
        details = json_value(row['details_json'], dict, 'Source check details')
        require(details.get('sourceKey') == row['source_key'] and details.get('status') == row['status'] and details.get('contentSha256') == row['content_sha256'], 'Source check details do not match the recorded result.')
    for row in db.execute('SELECT * FROM purge_events'):
        require(digest(row['content_sha256']) and isinstance(row['reason'], str) and bool(row['reason'].strip()), 'Invalid permanent deletion history.')
        require(row['cleanup_status'] in {'pending', 'complete'} and isinstance(row['snapshot_path'], str) and (row['cleanup_status'] != 'pending' or bool(row['snapshot_path'])), 'Invalid pending deletion cleanup record.')
        require(row['cleanup_error'] is None or isinstance(row['cleanup_error'], str), 'Invalid deletion cleanup error.')


def validate_retained_files(db, archive_root: Path):
    from .archive import artifact_paths, safe_archive_relative_path, safe_artifact_relative_path, sha256_file

    for event in db.execute("SELECT snapshot_path FROM purge_events WHERE snapshot_path != ''"):
        pending = archive_root / safe_archive_relative_path(event[0])
        snapshots = (archive_root / 'snapshots').resolve()
        require(pending.resolve().is_relative_to(snapshots) and pending.parent.resolve() != snapshots, 'Deletion cleanup path must name a file inside an individual retained snapshot directory.')
    for document in db.execute('SELECT * FROM documents'):
        relative = safe_archive_relative_path(document['snapshot_path'])
        path = archive_root / relative
        snapshots = (archive_root / 'snapshots').resolve()
        require(path.resolve().is_relative_to(snapshots) and path.parent.resolve() != snapshots and path.is_file(), 'Retained original must exist inside an individual archive snapshot directory.')
        require(sha256_file(path) == document['content_sha256'], 'Retained original failed its source SHA-256 validation.')
        manifest = json_value(document['source_manifest_json'], dict, 'Source manifest')
        metadata_path = path.parent / 'metadata.json'
        require(metadata_path.is_file(), 'Retained source metadata is missing.')
        require(json_value(metadata_path.read_text(), dict, 'Source metadata') == manifest['metadata'], 'Retained metadata differs from its source manifest.')
        if manifest['mode'] == 'legacy-generated-documentation':
            require(type(manifest.get('originalAvailable')) is bool, 'Legacy source availability must be explicitly classified.')
            if manifest['originalAvailable']:
                from .legacy_sources import legacy_code_sources
                _, originals = legacy_code_sources(path)
                require(originals == manifest.get('rawOriginals'), 'Legacy raw originals do not match the retained source manifest.')
            else:
                require(isinstance(manifest.get('rebuildBlocked'), str) and bool(manifest['rebuildBlocked']), 'Unavailable legacy originals require an explicit rebuild-blocked reason.')
        if manifest['mode'] == 'retained-evidence':
            spans = path.parent / 'source-spans.json'
            require(spans.is_file(), 'Retained media source requires rebuildable source spans.')
            records = json_value(spans.read_text(), list, 'Retained media spans')
            require(all(isinstance(row, dict) and isinstance(row.get('text'), str) and isinstance(row.get('locator'), str) for row in records), 'Invalid retained media source spans.')
        for row in db.execute('SELECT payload_json FROM document_artifacts WHERE document_id = ?', (document['document_id'],)):
            payload = json_value(row[0], dict, 'Artifact registry payload')
            for value in artifact_paths(payload):
                relative = safe_artifact_relative_path(value)
                artifact = path.parent / 'extracted' / relative
                require(artifact.resolve().is_relative_to((path.parent / 'extracted').resolve()) and artifact.is_file(), 'Registered artifact file is missing or outside its source directory.')
                if value == payload.get('path') and payload.get('sha256') is not None:
                    require(digest(payload['sha256']) and sha256_file(artifact) == payload['sha256'], 'Registered artifact failed its SHA-256 validation.')


def interrupt_transferred_jobs(db):
    db.execute("UPDATE enrichment_runs SET status='interrupted',lease_until=0 WHERE status='running'")
    db.execute('UPDATE enrichment_runs SET lease_until=0')
    db.execute("UPDATE reanalysis_campaigns SET status='interrupted' WHERE status IN ('queued','running')")
    db.execute("UPDATE reanalysis_items SET status='interrupted' WHERE status='running'")


def merge_archive_history(source, target):
    for table, identity in [('source_checks', 'check_id'), ('purge_events', 'purge_id')]:
        columns = [row['name'] for row in target.execute(f'PRAGMA table_info({table})') if row['name'] != identity]
        identity_columns = [key for key in columns if table != 'purge_events' or key not in {'cleanup_status', 'cleanup_error'}]
        condition = ' AND '.join(f'{key} IS ?' for key in identity_columns)
        for row in source.execute(f'SELECT * FROM {table}'):
            values = [row[key] for key in columns]
            if not target.execute(f'SELECT 1 FROM {table} WHERE {condition}', [row[key] for key in identity_columns]).fetchone():
                target.execute(f'INSERT INTO {table} (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', values)
    for row in source.execute('SELECT * FROM reanalysis_campaigns'):
        existing = target.execute('SELECT created_at FROM reanalysis_campaigns WHERE campaign_id=?', (row['campaign_id'],)).fetchone()
        require(existing is None or existing[0] == row['created_at'], 'Imported campaign identity conflicts with existing history.')
        if existing is None:
            status = 'interrupted' if row['status'] in {'queued', 'running'} else row['status']
            target.execute('INSERT INTO reanalysis_campaigns VALUES(?,?,?,?)', (row['campaign_id'], status, row['created_at'], row['updated_at']))
        for item in source.execute('SELECT * FROM reanalysis_items WHERE campaign_id=?', (row['campaign_id'],)):
            prior = target.execute('SELECT expected_revision FROM reanalysis_items WHERE campaign_id=? AND document_id=?', (item['campaign_id'], item['document_id'])).fetchone()
            require(prior is None or prior[0] == item['expected_revision'], 'Imported campaign input conflicts with existing history.')
            if prior is None:
                target.execute('INSERT INTO reanalysis_items VALUES(?,?,?,?,?)', (item['campaign_id'], item['document_id'], item['expected_revision'], 'interrupted' if item['status'] == 'running' else item['status'], item['error']))


def pending_purge_paths(source, target):
    identity = ['document_id', 'source_key', 'content_sha256', 'reason', 'purged_at', 'snapshot_path']
    where = ' AND '.join(f'{column} IS ?' for column in identity)
    for row in source.execute("SELECT * FROM purge_events WHERE cleanup_status='pending'"):
        completed = target.execute(f"SELECT 1 FROM purge_events WHERE {where} AND cleanup_status='complete'", [row[column] for column in identity]).fetchone()
        if completed is None:
            yield row['snapshot_path']
