import { describe, expect, it } from 'vitest';
import { assignSlugs, parseOrigin, resolveSlug } from '../../src/core/repos/slug';

describe('parseOrigin', () => {
  it.each([
    ['https://github.com/Acme/API.git', 'github.com', 'acme/api'],
    ['https://user:token@github.com/acme/api', 'github.com', 'acme/api'],
    ['git@github.com:acme/api.git', 'github.com', 'acme/api'],
    ['ssh://git@git.example.com:2222/team/sub/api.git', 'git.example.com', 'team/sub/api'],
    ['https://gitlab.com/acme/group/api/', 'gitlab.com', 'acme/group/api'],
  ])('%s', (url, host, path) => {
    expect(parseOrigin(url)).toEqual({ host, path });
  });

  it.each(['/Users/me/code/api', './api', 'file:///srv/git/api.git', 'C:\\code\\api', 'https://github.com/acme', ''])(
    'rejects %s',
    (url) => {
      expect(parseOrigin(url)).toBeNull();
    },
  );
});

describe('assignSlugs and resolveSlug', () => {
  const gh = parseOrigin('https://github.com/acme/api')!;
  const gl = parseOrigin('https://gitlab.com/acme/api')!;
  const other = parseOrigin('https://github.com/acme/web')!;

  const withInfo = (inputs: Parameters<typeof assignSlugs>[0]) => {
    const slugs = assignSlugs(inputs);
    return inputs.map((i) => ({ id: i.id, ...slugs.get(i.id)! }));
  };

  it('uses owner/name and the same slug for two clones of one origin', () => {
    const repos = withInfo([{ id: 'a', origin: gh }, { id: 'b', origin: gh }, { id: 'c', origin: other }]);
    expect(repos.map((r) => r.slug)).toEqual(['acme/api', 'acme/api', 'acme/web']);
  });

  it('adds the provider only when providers conflict', () => {
    const repos = withInfo([{ id: 'a', origin: gh }, { id: 'b', origin: gl }, { id: 'c', origin: other }]);
    expect(repos.map((r) => r.slug)).toEqual(['github/acme/api', 'gitlab/acme/api', 'acme/web']);
    expect(resolveSlug(repos, 'gitlab/acme/api')).toMatchObject({ kind: 'found', repo: { id: 'b' } });
    expect(resolveSlug(repos, 'acme/api')).toMatchObject({ kind: 'ambiguous' });
    expect(resolveSlug(repos, 'acme/web')).toMatchObject({ kind: 'found', repo: { id: 'c' } });
  });

  it('accepts the provider-qualified form when there is no conflict, ignoring case', () => {
    const repos = withInfo([{ id: 'a', origin: gh }]);
    expect(resolveSlug(repos, 'GitHub/Acme/API')).toMatchObject({ kind: 'found', repo: { id: 'a' } });
    expect(resolveSlug(repos, 'gitlab/acme/api')).toEqual({ kind: 'missing' });
  });

  it('prefers a configured id, then falls back to the registry id', () => {
    const repos = withInfo([{ id: 'a', origin: gh, configId: 'my-repo' }, { id: 'b' }]);
    expect(repos.map((r) => [r.slug, r.slugSource])).toEqual([
      ['my-repo', 'config'],
      ['local/b', 'registry'],
    ]);
  });
});
