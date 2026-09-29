/* Core schema: exploits-as-tickets, attempts, verdicts, nightly runs, operator queue, chat, audit. */
exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createType('exploit_status', [
    'open', 'in_progress', 'fixed', 'verified', 'false_positive', 'accepted_risk', 'regressed',
  ])
  pgm.createType('verdict_outcome', ['success', 'partial', 'fail'])
  pgm.createType('run_trigger', ['cron', 'run_now'])
  pgm.createType('request_kind', ['rerun', 'focus', 'skip', 'note'])
  pgm.createType('request_source', ['ui', 'chat'])
  pgm.createType('request_status', ['queued', 'ran', 'cut', 'cancelled'])

  pgm.createTable('targets', {
    id: 'id',
    base_url: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true },
    allowlisted_by: { type: 'text', notNull: true },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('target_versions', {
    id: 'id',
    target_id: { type: 'integer', notNull: true, references: 'targets', onDelete: 'CASCADE' },
    version: { type: 'text', notNull: true },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('target_versions', 'target_versions_unique', {
    unique: ['target_id', 'version'],
  })

  pgm.createTable('nightly_runs', {
    id: 'id',
    scheduled_for: { type: 'timestamptz', notNull: true },
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' },
    trigger: { type: 'run_trigger', notNull: true, default: 'cron' },
    plan: { type: 'jsonb' },
    summary: { type: 'jsonb' },
    spend_usd: { type: 'numeric(10,4)', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'scheduled' },
  })

  pgm.createTable('campaigns', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    nightly_run_id: { type: 'integer', references: 'nightly_runs', onDelete: 'SET NULL' },
    plan: { type: 'jsonb', notNull: true },
    budget_usd: { type: 'numeric(10,4)', notNull: true },
    spend_usd: { type: 'numeric(10,4)', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'pending' },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('attempts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    campaign_id: { type: 'uuid', references: 'campaigns', onDelete: 'CASCADE' },
    parent_attempt_id: { type: 'uuid', references: 'attempts', onDelete: 'SET NULL' },
    fingerprint: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    subcategory: { type: 'text' },
    owasp_ids: { type: 'text[]', notNull: true, default: '{}' },
    technique_tags: { type: 'text[]', notNull: true, default: '{}' },
    transcript: { type: 'jsonb', notNull: true },
    target_version_id: { type: 'integer', references: 'target_versions' },
    tokens: { type: 'integer', notNull: true, default: 0 },
    cost_usd: { type: 'numeric(10,6)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('attempts', ['target_version_id', 'category'])
  pgm.createIndex('attempts', 'fingerprint')

  pgm.createTable('exploits', {
    id: { type: 'text', primaryKey: true },
    fingerprint: { type: 'text', notNull: true, unique: true },
    severity: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true },
    subcategory: { type: 'text' },
    owasp_ids: { type: 'text[]', notNull: true, default: '{}' },
    status: { type: 'exploit_status', notNull: true, default: 'open' },
    assignee: { type: 'text' },
    min_repro: { type: 'jsonb', notNull: true },
    family_ids: { type: 'uuid[]', notNull: true, default: '{}' },
    discovered_version_id: { type: 'integer', references: 'target_versions' },
    fixed_version_id: { type: 'integer', references: 'target_versions' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('exploits', ['severity', 'status'])
  pgm.createIndex('exploits', ['category', 'subcategory'])

  pgm.createTable('verdicts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    attempt_id: { type: 'uuid', notNull: true, references: 'attempts', onDelete: 'CASCADE' },
    outcome: { type: 'verdict_outcome', notNull: true },
    confidence: { type: 'numeric(4,3)', notNull: true },
    stage: { type: 'text', notNull: true },
    rubric_version: { type: 'text', notNull: true },
    judge_model: { type: 'text' },
    evidence: { type: 'jsonb', notNull: true, default: '[]' },
    needs_review: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('verdicts', 'attempt_id')

  pgm.createTable('reports', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    exploit_id: { type: 'text', notNull: true, references: 'exploits', onDelete: 'CASCADE' },
    version: { type: 'integer', notNull: true, default: 1 },
    body: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true, default: 'draft' },
    approved_by: { type: 'text' },
    published_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('operator_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    kind: { type: 'request_kind', notNull: true },
    exploit_id: { type: 'text', references: 'exploits', onDelete: 'CASCADE' },
    category: { type: 'text' },
    requested_by: { type: 'text', notNull: true },
    requested_for: { type: 'date' },
    source: { type: 'request_source', notNull: true },
    reason: { type: 'text' },
    status: { type: 'request_status', notNull: true, default: 'queued' },
    nightly_run_id: { type: 'integer', references: 'nightly_runs', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('operator_requests', ['status', 'requested_for'])

  pgm.createTable('chat_messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    thread_id: { type: 'uuid', notNull: true },
    role: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    tool_calls: { type: 'jsonb' },
    directive_id: { type: 'uuid', references: 'operator_requests', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('agent_events', {
    id: { type: 'bigserial', primaryKey: true },
    trace_id: { type: 'text', notNull: true },
    agent: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb' },
    source: { type: 'text' },
    cost_usd: { type: 'numeric(10,6)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('agent_events', ['trace_id', 'created_at'])

  pgm.createTable('ground_truth', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    transcript: { type: 'jsonb', notNull: true },
    label: { type: 'verdict_outcome', notNull: true },
    category: { type: 'text', notNull: true },
    labeled_by: { type: 'text', notNull: true },
    labeled_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

exports.down = (pgm) => {
  pgm.dropTable('ground_truth')
  pgm.dropTable('agent_events')
  pgm.dropTable('chat_messages')
  pgm.dropTable('operator_requests')
  pgm.dropTable('reports')
  pgm.dropTable('verdicts')
  pgm.dropTable('exploits')
  pgm.dropTable('attempts')
  pgm.dropTable('campaigns')
  pgm.dropTable('nightly_runs')
  pgm.dropTable('target_versions')
  pgm.dropTable('targets')
  pgm.dropType('request_status')
  pgm.dropType('request_source')
  pgm.dropType('request_kind')
  pgm.dropType('run_trigger')
  pgm.dropType('verdict_outcome')
  pgm.dropType('exploit_status')
}
