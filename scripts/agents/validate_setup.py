"""Validate native agent wiring; --migration-check additionally audits against HEAD."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
EXPLICIT_SKILLS = {'grill-me', 'grill-with-docs', 'handoff', 'to-spec',
                   'finishing-a-development-branch'}
WORKFLOW_SKILLS = {'writing-plans', 'executing-plans', 'systematic-debugging',
                   'verification-before-completion', 'requesting-code-review',
                   'finishing-a-development-branch'}
GUIDE_BYTE_LIMIT = 8192
WORKFLOW_BYTE_LIMIT = 3072
WORKFLOW_TOTAL_BYTE_LIMIT = 12288


def require(ok, message):
    if not ok:
        raise ValueError(message)


def git_text(path):
    return subprocess.check_output(['git', 'show', f'HEAD:{path}'], cwd=ROOT).decode()


def load_yaml(paths, *, frontmatter=False):
    """Use the project's real YAML parser for skill metadata and Codex policy."""
    js = """const fs=require('fs'),yaml=require('js-yaml');
    const {paths,frontmatter}=JSON.parse(fs.readFileSync(0,'utf8'));
    process.stdout.write(JSON.stringify(paths.map(p=>{
      let s=fs.readFileSync(p,'utf8').replace(/\\r/g,'');
      if(frontmatter){
        if(!s.startsWith('---\\n'))throw Error('Missing frontmatter: '+p);
        const end=s.indexOf('\\n---\\n',4);if(end<0)throw Error('Unclosed frontmatter: '+p);
        s=s.slice(4,end);
      }
      return yaml.load(s);
    })));"""
    result = subprocess.run(['node', '-e', js],
                            input=json.dumps({'paths': [str(p) for p in paths],
                                              'frontmatter': frontmatter}),
                            text=True, capture_output=True, cwd=ROOT, check=True)
    return json.loads(result.stdout)


def validate_context_budget(guide, skills):
    require(len(guide.encode('utf-8')) <= GUIDE_BYTE_LIMIT,
            'AGENTS.md exceeds 8 KiB context budget')
    require(WORKFLOW_SKILLS <= skills.keys(), 'Missing core workflow skills')
    sizes = {name: len(skills[name].encode('utf-8')) for name in WORKFLOW_SKILLS}
    for name, size in sizes.items():
        require(size <= WORKFLOW_BYTE_LIMIT, f'{name} exceeds 3 KiB context budget')
    total = sum(sizes.values())
    require(total <= WORKFLOW_TOTAL_BYTE_LIMIT, 'Workflow skills exceed 12 KiB combined context budget')
    return total


def validate_invocation_policy(name, data, policy):
    require('disable-model-invocation' not in data or
            (name in EXPLICIT_SKILLS and data['disable-model-invocation'] is True),
            f'Invocation policy: {name}')
    if name in EXPLICIT_SKILLS:
        require('explicitly requested' in data['description'], f'Missing explicit trigger: {name}')
        require(data.get('disable-model-invocation') is True, f'Missing manual-only frontmatter: {name}')
        require(isinstance(policy, dict) and isinstance(policy.get('policy'), dict) and
                policy['policy'].get('allow_implicit_invocation') is False,
                f'Missing/invalid Codex explicit-only policy: {name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migration-check', action='store_true')
    args = parser.parse_args()
    skills = sorted((ROOT / '.agents/skills').glob('*/SKILL.md'))
    parsed = load_yaml(skills, frontmatter=True)
    policy_paths = [p.parent / 'agents/openai.yaml' for p in skills
                    if (p.parent / 'agents/openai.yaml').is_file()]
    policies = dict(zip(policy_paths, load_yaml(policy_paths)))
    names = set()
    for p, data in zip(skills, parsed):
        require(isinstance(data, dict), f'Invalid frontmatter: {p}')
        name = data['name']
        require(name == p.parent.name and re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', name)
                and len(name) <= 64, f'Invalid skill name: {p}')
        require(name not in names, f'Duplicate canonical name: {name}')
        names.add(name)
        desc = data['description']
        require(isinstance(desc, str) and 1 <= len(desc) <= 1024 and
                not any(x in desc for x in (': ', '<', '>', '"', "'")), f'Invalid description: {p}')
        require(set(data) <= {'name', 'description', 'metadata', 'disable-model-invocation'}, f'Unexpected fields: {p}')
        validate_invocation_policy(name, data, policies.get(p.parent / 'agents/openai.yaml'))
        link = ROOT / '.claude/skills' / name
        require((link / 'SKILL.md').is_file(), f'Missing/dangling Claude skill: {name}')
        require(os.path.samefile(link / 'SKILL.md', p), f'Copied or wrong Claude skill: {name}')
        if os.name != 'nt':
            require(link.is_symlink() and os.readlink(link) == f'../../.agents/skills/{name}', f'Wrong relative link: {name}')
    require(names, 'No canonical skills')
    require({p.name for p in (ROOT / '.claude/skills').iterdir()} == names, 'Extra/stale Claude entries')
    guide = (ROOT / 'AGENTS.md').read_text(encoding='utf-8')
    index = guide.split('## Skills index\n', 1)[1].split('\n## ', 1)[0]
    listed = set(re.findall(r'^\| ([a-z][a-z0-9-]+) \|', index, re.M))
    require(listed == names, f'Index mismatch: {listed ^ names}')
    workflow_bytes = validate_context_budget(guide, {p.parent.name: p.read_text(encoding='utf-8') for p in skills})
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
    print(f'Core workflow skills: {workflow_bytes} bytes / {WORKFLOW_TOTAL_BYTE_LIMIT} byte combined budget.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, OSError, KeyError) as exc:
        print(f'Agent setup validation failed: {exc}', file=sys.stderr)
        sys.exit(1)
