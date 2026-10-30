"""Customer selections remain private and drive the actual model adapters."""
from types import SimpleNamespace as NS
import pytest
from fastapi import HTTPException
from app.main import app
from app.core.auth import require_user
from app.services.customer_models import selected_model_id
from app.services.workspace_settings import write_preferences, read_preferences
from tests.test_model_config_catalog import setup, payload


def create(client, kind, name, **extra):
    result = client.post('/api/settings/model-configs/' + kind, json={**payload(name, kind), **extra})
    assert result.status_code == 201, result.text
    return result.json()


def switch(user):
    app.dependency_overrides[require_user] = lambda: NS(id=user, role='user')


def test_safe_catalog_and_closed_configs_not_selectable(setup):
    client, _ = setup
    profiles = {}
    for kind in ('image', 'embedding', 'rerank'):
        visible = create(client, kind, 'open-' + kind, apiKey='test-only-key')
        closed = create(client, kind, 'closed-' + kind, enabled=False, apiKey='test-only-hidden-key')
        profiles[kind] = (visible, closed)
    catalogs = client.get('/api/settings/available-models').json()
    for kind, (visible, closed) in profiles.items():
        assert [p['id'] for p in catalogs[kind]['models']] == [visible['id']]
        assert catalogs[kind]['defaultId'] == visible['id']
        assert set(catalogs[kind]['models'][0]) == {'id', 'name', 'model', 'isDefault'}
        assert client.put('/api/settings/preferences', json={kind + 'ModelId': closed['id']}).status_code == 400
    for secret in ('baseUrl', 'keyHint', 'apiKey', 'test-only', 'example.test'):
        assert secret not in str(catalogs)
    assert client.get('/api/settings/image-models').json() == catalogs['image']


def test_preferences_are_private_and_do_not_change_platform_defaults(setup):
    client, factory = setup
    first, second = {}, {}
    for kind in ('image', 'embedding', 'rerank'):
        first[kind] = create(client, kind, 'first-' + kind)
        second[kind] = create(client, kind, 'second-' + kind)
        client.post('/api/settings/model-configs/' + kind + '/' + first[kind]['id'] + '/activate')
    switch('alice')
    saved = {kind + 'ModelId': p['id'] for kind, p in second.items()}
    assert client.put('/api/settings/preferences', json=saved).status_code == 200
    for field, value in saved.items():
        assert client.get('/api/settings/preferences').json()[field] == value
    switch('bob')
    for kind in first:
        assert client.get('/api/settings/preferences').json()[kind + 'ModelId'] is None
        with factory() as db:
            assert selected_model_id(db, kind, 'alice') == second[kind]['id']
            assert selected_model_id(db, kind, 'bob') == first[kind]['id']
        assert client.get('/api/settings/model-configs/' + kind).json()['activeId'] == first[kind]['id']


@pytest.mark.parametrize('kind', ['image', 'embedding', 'rerank'])
def test_retired_saved_selection_falls_back_but_explicit_selection_is_rejected(setup, kind):
    client, factory = setup
    first = create(client, kind, 'first')
    second = create(client, kind, 'second')
    assert client.put('/api/settings/preferences', json={kind + 'ModelId': second['id']}).status_code == 200
    assert client.patch('/api/settings/model-configs/' + kind + '/' + second['id'], json={**payload('second', kind), 'enabled': False}).status_code == 200
    assert client.get('/api/settings/preferences').json()[kind + 'ModelId'] is None
    with factory() as db:
        assert selected_model_id(db, kind, 'u-test') == first['id']
        with pytest.raises(HTTPException):
            selected_model_id(db, kind, 'u-test', second['id'])


def test_image_preferences_and_explicit_override_reach_provider(setup, monkeypatch):
    import openai
    from app.services.media_service import MediaService
    client, factory = setup
    first = create(client, 'image', 'first', apiKey='test-only-first')
    second = create(client, 'image', 'second', apiKey='test-only-second')
    assert client.put('/api/settings/preferences', json={'imageModelId': second['id']}).status_code == 200
    calls = []
    def provider(**options):
        def generate(**body):
            calls.append((options['api_key'], body['model']))
            return NS(data=[NS(b64_json='test-only-image', url=None)])
        return NS(images=NS(generate=generate))
    monkeypatch.setattr(openai, 'OpenAI', provider)
    with factory() as db:
        service = MediaService(db)
        service.add_generated = lambda **kwargs: {'id': 'generated'}
        service.generate(prompt='landscape', owner_user_id='u-test')
        service.generate(prompt='landscape', owner_user_id='u-test', image_profile_id=first['id'])
    assert calls == [('test-only-second', 'second-model'), ('test-only-first', 'first-model')]


@pytest.mark.parametrize('kind', ['image', 'embedding', 'rerank'])
def test_empty_and_closed_catalogs_do_not_use_hidden_runtime_defaults(setup, kind):
    client, factory = setup
    with factory() as db:
        with pytest.raises(HTTPException) as exc:
            selected_model_id(db, kind, 'u-test')
        assert exc.value.status_code == 501
    create(client, kind, 'closed', enabled=False)
    with factory() as db:
        with pytest.raises(HTTPException) as exc:
            selected_model_id(db, kind, 'u-test')
        assert exc.value.status_code == 501


def test_preview_uses_customer_preference(setup, monkeypatch):
    import openai
    client, _ = setup
    create(client, 'image', 'platform', apiKey='test-only-platform')
    chosen = create(client, 'image', 'personal', apiKey='test-only-personal')
    client.put('/api/settings/preferences', json={'imageModelId': chosen['id']})
    calls = []
    def provider(**options):
        def generate(**body):
            calls.append((options['api_key'], body['model']))
            return NS(data=[NS(b64_json='test-image', url=None)])
        return NS(images=NS(generate=generate))
    monkeypatch.setattr(openai, 'OpenAI', provider)
    result = client.post('/api/media/preview', json={'prompt': 'landscape'})
    assert result.status_code == 200
    assert calls == [('test-only-personal', 'personal-model')]


def test_user_bound_retrieval_configs_are_not_shared(setup, monkeypatch, tmp_path):
    from app.services import rag_service, retrieval_models
    client, factory = setup
    first, second = {}, {}
    for kind in ('embedding', 'rerank'):
        first[kind] = create(client, kind, 'first-' + kind, apiKey='test-only-first')
        second[kind] = create(client, kind, 'second-' + kind, apiKey='test-only-second')
    with factory() as db:
        write_preferences(db, 'user:alice', {kind + 'ModelId': p['id'] for kind, p in second.items()})
        alice = rag_service.get_rag_service(db=db, owner_user_id='alice')
        bob = rag_service.get_rag_service(db=db, owner_user_id='bob')
    assert alice is not bob
    for kind in ('embedding', 'rerank'):
        assert alice.runtime_configs[kind]['api_key'] == 'test-only-second'
        assert bob.runtime_configs[kind]['api_key'] == 'test-only-first'
    observed = []
    monkeypatch.setattr(retrieval_models, 'embed', lambda cfg, texts, **kwargs: observed.append(('embed', cfg['model'])) or [[1.0, 0.2] for _ in texts])
    monkeypatch.setattr(retrieval_models, 'rerank', lambda cfg, query, texts: observed.append(('rerank', cfg['model'])) or [(0, 0.9)])
    for service in (alice, bob):
        service._embed(['text'])
        service._rerank('query', ['text'])
    assert observed == [('embed', 'second-embedding-model'), ('rerank', 'second-rerank-model'), ('embed', 'first-embedding-model'), ('rerank', 'first-rerank-model')]
    # Equal dimensions cannot make vectors from different models compatible.
    alice.index_dir = bob.index_dir = tmp_path
    alice.ingest('shared-test', 'doc', '苹果水果资料')
    with pytest.raises(rag_service.RAGUnavailable, match='向量模型已变更'):
        bob.search(['shared-test'], '苹果')
    assert bob.stats('shared-test')['documents'] == {'doc': 1}


def test_ordinary_customer_cannot_mutate_catalog(setup):
    from app.core.auth import require_admin, get_current_user
    client, _ = setup
    app.dependency_overrides.pop(require_admin, None)
    app.dependency_overrides[get_current_user] = lambda: NS(id='alice', role='user')
    try:
        assert client.post('/api/settings/model-configs/embedding', json=payload('blocked', 'embedding')).status_code == 403
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_index_identity_survives_deletion_and_blocks_legacy_vectors(tmp_path, monkeypatch):
    import json
    from app.services.rag_service import RagService, RAGUnavailable
    service = RagService(str(tmp_path))
    def embed(texts):
        service._vector_model = 'new-model'
        return [[1.0, 0.2] for _ in texts]
    monkeypatch.setattr(service, '_embed', embed)
    service.ingest('index', 'first', '苹果资料')
    service.ingest('index', 'second', '香蕉资料')
    assert service.remove_document('index', 'first')
    assert json.loads(service._path('index').read_text())['embeddingModel'] == 'new-model'
    legacy = {'chunks': [{'source': 'old', 'text': '旧资料'}], 'vectors': [[1.0, 0.2]]}
    service._save('legacy', legacy)
    with pytest.raises(RAGUnavailable, match='向量模型已变更'):
        service.ingest('legacy', 'another', '新资料')
    assert service.stats('legacy')['documents'] == {'old': 1}
    # Replacing the sole old document safely rebuilds its vectors and identity.
    service.ingest('legacy', 'old', '替换资料')
    assert json.loads(service._path('legacy').read_text())['embeddingModel'] == 'new-model'
