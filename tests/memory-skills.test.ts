import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('memory (§16/§17/§64)', () => {
  it('candidates need review, then become searchable; deletion works', async () => {
    const t = await makeTestApp();
    try {
      const e = t.app.memory.add({ content: 'user prefers pnpm over npm for js projects', type: 'preference', source: 'user' });
      expect(e.status).toBe('candidate'); // requireReview default
      // not searchable while pending review
      expect(await t.app.memory.search('pnpm')).toHaveLength(0);
      expect(t.app.memory.confirm(e.id)).toBe(true);
      const hits = await t.app.memory.search('pnpm npm packages');
      expect(hits.length).toBe(1);
      expect(hits[0]?.entry.id).toBe(e.id);
      expect(t.app.memory.delete(e.id)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('auto-confirms explicit user memories and dedups near-identical content (§17)', async () => {
    const t = await makeTestApp({ config: { memory: { requireReview: false } } });
    try {
      const a = t.app.memory.add({ content: 'user prefers dark theme in all editors', type: 'preference', importance: 0.6 });
      const b = t.app.memory.add({ content: 'user prefers dark theme in all editors!', type: 'preference' });
      expect(b.id).toBe(a.id); // merged, not duplicated
      expect(t.app.memory.list('stored').length).toBe(1);
      expect(t.app.memory.list('stored')[0]?.importance).toBeGreaterThan(0.6); // merge strengthens
    } finally {
      await t.cleanup();
    }
  });

  it('compress merges duplicates across history and prunes stale episodes', async () => {
    const t = await makeTestApp({ config: { memory: { requireReview: false } } });
    try {
      t.app.memory.add({ content: 'the api gateway runs on port 8443 with tls', type: 'fact' });
      t.app.memory.add({ content: 'the api gateway runs on port 8443 with tls configured', type: 'fact' });
      for (let i = 0; i < 5; i++)
        t.app.memory.add({ content: `episode note ${i} about unrelated topic`, type: 'episode', importance: 0.2 });
      const before = t.app.memory.list('stored').length;
      const { merged } = t.app.memory.compress();
      expect(merged).toBeGreaterThanOrEqual(1);
      expect(t.app.memory.list('stored').length).toBe(before - merged);
    } finally {
      await t.cleanup();
    }
  });

  it('project-scoped memory is only injected for its project (§64 scope)', async () => {
    const t = await makeTestApp({ config: { memory: { requireReview: false } } });
    try {
      t.app.memory.add({ content: 'this project uses postgres 16', type: 'project_knowledge', projectId: 'proj_A' });
      t.app.memory.add({ content: 'the user birthday is june 3', type: 'fact' });
      const hitsA = await t.app.memory.search('postgres version', { projectId: 'proj_A' });
      expect(hitsA.some((h) => h.entry.content.includes('postgres'))).toBe(true);
      const hitsB = await t.app.memory.search('postgres version', { projectId: 'proj_B' });
      expect(hitsB.some((h) => h.entry.content.includes('postgres'))).toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});

describe('skills + learning (§18/§19/§65)', () => {
  it('repeated confirmed correction becomes a promotable skill after user review', async () => {
    const t = await makeTestApp();
    try {
      t.app.skills.recordCorrection({
        key: 'run:pnpm-first',
        previousBehavior: 'used npm install',
        correction: 'always use pnpm install in this repo, npm breaks the lockfile',
        context: 'workspace repo',
      });
      // one occurrence is not enough — do not learn too eagerly (§18)
      expect(t.app.skills.promotableCandidates()).toHaveLength(0);
      t.app.skills.recordCorrection({
        key: 'run:pnpm-first',
        previousBehavior: 'used npm install',
        correction: 'always use pnpm install in this repo, npm breaks the lockfile',
        context: 'workspace repo',
      });
      const candidates = t.app.skills.promotableCandidates();
      expect(candidates).toHaveLength(1);
      const skill = t.app.skills.promoteToSkill(candidates[0]!.id, 'use-pnpm');
      expect(skill).toBeTruthy();
      expect(t.app.skills.list().map((s) => s.name)).toContain('use-pnpm');
      expect(t.app.skills.promotableCandidates()).toHaveLength(0);
      // skills are toggleable/removable
      expect(t.app.skills.toggle(skill!.id, false)).toBe(true);
      expect(t.app.skills.relevantFor('install packages with pnpm')).toHaveLength(0);
      t.app.skills.toggle(skill!.id, true);
      expect(t.app.skills.relevantFor('install packages with pnpm').length).toBe(1);
      expect(t.app.skills.delete(skill!.id)).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('user-defined skill auto-selects for matching task text (§19)', async () => {
    const t = await makeTestApp();
    try {
      t.app.skills.createFromUser({
        name: 'deploy-staging',
        description: 'deploy to staging via scripts/deploy.sh after tests pass',
        instructions: 'run npm test; if green run ./scripts/deploy.sh',
        requiredTools: ['run_command'],
        verification: 'staging health endpoint returns 200',
      });
      const rel = t.app.skills.relevantFor('please deploy to staging for me');
      expect(rel).toHaveLength(1);
      expect(rel[0]?.name).toBe('deploy-staging');
    } finally {
      await t.cleanup();
    }
  });
});
