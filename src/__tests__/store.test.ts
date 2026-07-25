import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set up a temp home before importing store
const TMP_DIR = path.join(os.tmpdir(), `bridge-test-${Date.now()}`);
process.env.CTI_HOME = TMP_DIR;

// Need to re-import after setting env
const { JsonFileStore } = await import('../store.js');
const { loadConfig } = await import('../config.js');

describe('JsonFileStore', () => {
  let store: InstanceType<typeof JsonFileStore>;

  beforeEach(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const config = loadConfig();
    store = new JsonFileStore(config);
  });

  afterEach(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('sessions', () => {
    it('creates and retrieves a session', () => {
      const session = store.createSession('test', 'claude-sonnet-5', undefined, '/tmp/project');
      expect(session.id).toBeTruthy();
      expect(session.model).toBe('claude-sonnet-5');

      const retrieved = store.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.model).toBe('claude-sonnet-5');
    });

    it('returns null for non-existent session', () => {
      expect(store.getSession('nonexistent')).toBeNull();
    });
  });

  describe('channel bindings', () => {
    it('upserts and retrieves bindings', () => {
      const session = store.createSession('test', 'gpt-5', undefined, '/tmp/proj');
      const binding = store.upsertChannelBinding({
        chatId: 'oc_test123',
        codepilotSessionId: session.id,
        workingDirectory: '/tmp/proj',
        model: 'gpt-5',
      });

      expect(binding.chatId).toBe('oc_test123');
      expect(binding.requireMention).toBe(true); // default

      const retrieved = store.getChannelBinding('oc_test123');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.codepilotSessionId).toBe(session.id);
    });

    it('updates existing binding', () => {
      const session = store.createSession('test', 'gpt-5', undefined, '/tmp/proj');
      const binding = store.upsertChannelBinding({
        chatId: 'oc_test456',
        codepilotSessionId: session.id,
        workingDirectory: '/tmp/proj',
        model: 'gpt-5',
      });

      store.updateChannelBinding(binding.id, { mode: 'plan', requireMention: false });

      const retrieved = store.getChannelBinding('oc_test456');
      expect(retrieved!.mode).toBe('plan');
      expect(retrieved!.requireMention).toBe(false);
    });
  });

  describe('workspaces', () => {
    it('saves and lists workspaces', () => {
      store.saveWorkspace('frontend', '/home/user/frontend');
      store.saveWorkspace('backend', '/home/user/backend');

      const list = store.listWorkspaces();
      expect(list.length).toBe(2);
      expect(list[0].name).toBe('backend'); // sorted
      expect(list[1].name).toBe('frontend');
    });

    it('gets and removes workspace', () => {
      store.saveWorkspace('test', '/tmp/test');
      expect(store.getWorkspace('test')).not.toBeNull();
      expect(store.removeWorkspace('test')).toBe(true);
      expect(store.getWorkspace('test')).toBeNull();
      expect(store.removeWorkspace('nonexistent')).toBe(false);
    });
  });

  describe('access control', () => {
    it('auto-sets creator on first setCreator call', () => {
      store.setCreator('ou_user1');
      const access = store.getAccess();
      expect(access.creator).toBe('ou_user1');
      expect(access.allowedUsers).toContain('ou_user1');
    });

    it('ignores setCreator after creator is set', () => {
      store.setCreator('ou_user1');
      store.setCreator('ou_user2'); // ignored
      expect(store.getAccess().creator).toBe('ou_user1');
    });

    it('adds and removes users', () => {
      store.setCreator('ou_creator');
      store.addAllowedUser('ou_user2');
      expect(store.isAuthorized('ou_user2', 'oc_x')).toBe(true);
      store.removeAllowedUser('ou_user2');
      expect(store.isAuthorized('ou_user2', 'oc_x')).toBe(false);
    });

    it('creator is always authorized', () => {
      store.setCreator('ou_creator');
      expect(store.isCreatorOrAdmin('ou_creator')).toBe(true);
      expect(store.isAuthorized('ou_creator', 'oc_x')).toBe(true);
    });

    it('admin is always authorized', () => {
      store.setCreator('ou_creator');
      store.addAdmin('ou_admin');
      store.addAllowedUser('ou_admin');
      expect(store.isCreatorOrAdmin('ou_admin')).toBe(true);
      expect(store.isAuthorized('ou_admin', 'oc_x')).toBe(true);
    });

    it('allows everyone when lists are empty', () => {
      // No creator set, lists empty
      expect(store.isAuthorized('random_user', 'random_chat')).toBe(true);
    });

    it('checks chat authorization', () => {
      store.setCreator('ou_creator');
      store.addAllowedChat('oc_group1');
      expect(store.isAuthorized('random_user', 'oc_group1')).toBe(true);
      expect(store.isAuthorized('random_user', 'oc_group2')).toBe(false);
    });
  });

  describe('session locks', () => {
    it('acquires and releases locks', () => {
      const session = store.createSession('test', 'model', undefined, '/tmp');
      expect(store.acquireSessionLock(session.id, 'lock1', 'owner', 60)).toBe(true);
      // Same lock id can re-acquire
      expect(store.acquireSessionLock(session.id, 'lock1', 'owner', 60)).toBe(true);
      // Different lock id fails
      expect(store.acquireSessionLock(session.id, 'lock2', 'owner2', 60)).toBe(false);
      store.releaseSessionLock(session.id, 'lock1');
      // New lock can acquire after release
      expect(store.acquireSessionLock(session.id, 'lock2', 'owner2', 60)).toBe(true);
    });
  });

  describe('usage tracking', () => {
    it('accumulates and retrieves usage', () => {
      const session = store.createSession('test', 'model', undefined, '/tmp');
      store.accumulateUsage(session.id, { input_tokens: 100, output_tokens: 50 });
      store.accumulateUsage(session.id, { input_tokens: 200, output_tokens: 100 });

      const usage = store.getSessionUsage(session.id);
      expect(usage).not.toBeNull();
      expect(usage!.input_tokens).toBe(300);
      expect(usage!.output_tokens).toBe(150);
    });

    it('returns null for unknown session', () => {
      expect(store.getSessionUsage('nonexistent')).toBeNull();
    });
  });
});
