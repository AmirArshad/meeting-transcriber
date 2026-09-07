"""Validate native agent wiring; --migration-check additionally audits against HEAD."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def require(ok, message):
    if not ok:
        raise ValueError(message)


def git_text(path):
    return subprocess.check_output(['git', 'show', f'HEAD:{path}'], cwd=ROOT).decode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migration-check', action='store_true')
    args = parser.parse_args()
    skills = sorted((ROOT / '.agents/skills').glob('*/SKILL.md'))
    # Use the project's real YAML parser, not a permissive fake frontmatter parser.
    js = """const fs=require('fs'),yaml=require('js-yaml');
    const paths=JSON.parse(fs.readFileSync(0,'utf8'));
    process.stdout.write(JSON.stringify(paths.map(p=>{
      const s=fs.readFileSync(p,'utf8').replace(/\\r/g,'');
      if(!s.startsWith('---\\n'))throw Error('Missing frontmatter: '+p);
      const end=s.indexOf('\\n---\\n',4);if(end<0)throw Error('Unclosed frontmatter: '+p);
      return yaml.load(s.slice(4,end));
    })));"""
    result = subprocess.run(['node', '-e', js], input=json.dumps([str(p) for p in skills]),
                            text=True, capture_output=True, cwd=ROOT, check=True)
    parsed = json.loads(result.stdout)
    names = set()
    explicit = {'grill-me', 'grill-with-docs', 'handoff', 'to-spec'}
    for p, data in zip(skills, parsed):
        name = data['name']
        require(name == p.parent.name and re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', name)
                and len(name) <= 64, f'Invalid skill name: {p}')
        require(name not in names, f'Duplicate canonical name: {name}')
        names.add(name)
        desc = data['description']
        require(isinstance(desc, str) and 1 <= len(desc) <= 1024 and
                not any(x in desc for x in (': ', '<', '>', '"', "'")), f'Invalid description: {p}')
        require(set(data) <= {'name', 'description', 'metadata', 'disable-model-invocation'}, f'Unexpected fields: {p}')
        require('disable-model-invocation' not in data or (name in explicit and data['disable-model-invocation'] is True), f'Invocation policy: {p}')
        if name in explicit:
            require('explicitly requested' in desc, f'Missing explicit trigger: {p}')
            policy = p.parent / 'agents/openai.yaml'
            require(policy.is_file() and 'allow_implicit_invocation: false' in policy.read_text(), f'Missing Codex policy: {p}')
        link = ROOT / '.claude/skills' / name
        require((link / 'SKILL.md').is_file(), f'Missing/dangling Claude skill: {name}')
        require(os.path.samefile(link / 'SKILL.md', p), f'Copied or wrong Claude skill: {name}')
        if os.name != 'nt':
            require(link.is_symlink() and os.readlink(link) == f'../../.agents/skills/{name}', f'Wrong relative link: {name}')
    require(names, 'No canonical skills')
    require({p.name for p in (ROOT / '.claude/skills').iterdir()} == names, 'Extra/stale Claude entries')
    guide = (ROOT / 'AGENTS.md').read_text()
    index = guide.split('## Skills index\n', 1)[1].split('\n## ', 1)[0]
    listed = set(re.findall(r'^\| ([a-z][a-z0-9-]+) \|', index, re.M))
    require(listed == names, f'Index mismatch: {listed ^ names}')
    require(len(guide.encode()) < 12288, 'AGENTS.md exceeds soft size cap')
    require((ROOT / 'CLAUDE.md').read_text() == '@AGENTS.md\n', 'Non-thin Claude adapter')
    require('instructions' not in json.loads((ROOT / 'opencode.json').read_text()), 'Unconditional OpenCode instructions')
    for p in (ROOT / '.cursor/rules').glob('*.mdc'):
        text = p.read_text()
        require('alwaysApply: false' in text and re.search(r'^globs: .+', text, re.M), f'Unscoped rule: {p}')
        body = text.split('---', 2)[2].strip()
        require(re.fullmatch(r'Read `[^`]+` before changing matching files\.', body), f'Non-pointer rule: {p}')
        require((ROOT / body.split('`')[1]).is_file(), f'Dangling rule pointer: {p}')
    for path in re.findall(r'`([^`]+)`', guide):
        if path.startswith(('docs/', 'tests/', 'src/', 'backend/', 'build/')) and not any(c in path for c in '*<> '):
            require((ROOT / path).exists(), f'Dangling root path: {path}')
    scripts = json.loads((ROOT / 'package.json').read_text())['scripts']
    for command in re.findall(r'`(npm [^`]+)`', guide):
        for chunk in command.split(' / '):
            words = chunk.split()
            if words[:2] == ['npm', 'run']: require(words[2] in scripts, f'Unknown command: {chunk}')
            elif words[1] not in ('ci', 'install'): require(words[1] in scripts, f'Unknown command: {chunk}')
    if args.migration_check:
        old = git_text('AGENTS.md')
        if '<!--\n' in old:
            block = old.split('<!--\n', 1)[1].rsplit('-->', 1)[0].strip()
            destinations = list((ROOT / 'docs/development/contracts').glob('*.md')) + [ROOT / 'docs/development' / x for x in ('BACKEND.md', 'TESTING.md', 'AGENT_SETUP_AUDIT.md')]
            texts = [p.read_text() for p in destinations]
            for part in re.split(r'(?m)^(?=#{2,3} )', block):
                require(any(part.strip() in t for t in texts), f'Dropped old section: {part[:90]}')
        for p in skills:
            before = git_text(p.relative_to(ROOT).as_posix())
            require(before.split('---', 2)[2] == p.read_text().split('---', 2)[2], f'Skill body changed: {p}')
        for filename in ('SKILL.md', 'LICENSE.txt'):
            require(git_text(f'.claude/skills/frontend-design/{filename}') == git_text(f'.agents/skills/frontend-design/{filename}'), f'Non-identical removed duplicate: {filename}')
        require(not subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=ROOT).strip(), 'Unexpected staged changes')
    print(f'Validated {len(names)} canonical skills, links, index, YAML, commands and adapters.')
    print(f'AGENTS.md: {len(guide.encode())} bytes, about {(len(guide.encode()) + 3) // 4} tokens, {len(guide.splitlines())} lines.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, OSError, KeyError) as exc:
        print(f'Agent setup validation failed: {exc}', file=sys.stderr)
        sys.exit(1)
