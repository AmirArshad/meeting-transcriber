"""Guard instruction budgets and real YAML invocation semantics with small fixtures."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.agents import validate_setup as setup


class ContextBudgetTests(unittest.TestCase):
    def setUp(self):
        self.skills = dict.fromkeys(setup.WORKFLOW_SKILLS, 'small workflow')

    def test_guide_boundary(self):
        setup.validate_context_budget('x' * setup.GUIDE_BYTE_LIMIT, self.skills)
        with self.assertRaisesRegex(ValueError, 'AGENTS.md exceeds'):
            setup.validate_context_budget('x' * (setup.GUIDE_BYTE_LIMIT + 1), self.skills)

    def test_budget_counts_utf8_bytes(self):
        with self.assertRaisesRegex(ValueError, 'AGENTS.md exceeds'):
            setup.validate_context_budget('é' * (setup.GUIDE_BYTE_LIMIT // 2 + 1), self.skills)

    def test_individual_workflow_boundary(self):
        self.skills['writing-plans'] = 'x' * setup.WORKFLOW_BYTE_LIMIT
        setup.validate_context_budget('', self.skills)
        self.skills['writing-plans'] += 'x'
        with self.assertRaisesRegex(ValueError, 'writing-plans exceeds'):
            setup.validate_context_budget('', self.skills)

    def test_combined_budget_catches_many_small_workflows(self):
        self.skills = dict.fromkeys(setup.WORKFLOW_SKILLS, 'x' * 2048)
        self.assertEqual(setup.validate_context_budget('', self.skills), setup.WORKFLOW_TOTAL_BYTE_LIMIT)
        self.skills['writing-plans'] += 'x'
        with self.assertRaisesRegex(ValueError, 'combined context budget'):
            setup.validate_context_budget('', self.skills)

    def test_missing_workflow_cannot_evade_budget(self):
        del self.skills['writing-plans']
        with self.assertRaisesRegex(ValueError, 'Missing core workflow'):
            setup.validate_context_budget('', self.skills)


class InvocationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.data = {'description': 'Use only when explicitly requested.',
                     'disable-model-invocation': True}

    def parse(self, text):
        with tempfile.TemporaryDirectory(prefix='agent-yaml-') as directory:
            path = Path(directory) / 'openai.yaml'
            path.write_text(text, encoding='utf-8')
            return setup.load_yaml([path])[0]

    def test_real_yaml_false_is_accepted_for_all_explicit_skills(self):
        policy = self.parse('policy:\n  allow_implicit_invocation: false\n')
        for name in setup.EXPLICIT_SKILLS:
            with self.subTest(name=name):
                setup.validate_invocation_policy(name, self.data, policy)

    def test_false_looking_values_are_rejected(self):
        for text in ('# allow_implicit_invocation: false\n',
                     'policy:\n  allow_implicit_invocation: "false"\n',
                     'policy:\n  allow_implicit_invocation: true\n',
                     'policy:\n  allow_implicit_invocation: 0\n',
                     'allow_implicit_invocation: false\n',
                     'policy: []\n'):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, 'Codex explicit-only policy'):
                setup.validate_invocation_policy('handoff', self.data, self.parse(text))

    def test_duplicate_yaml_keys_fail(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.parse('policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true\n')

    def test_frontmatter_must_disable_automatic_invocation(self):
        policy = self.parse('policy:\n  allow_implicit_invocation: false\n')
        for value in (False, 'true', None):
            data = dict(self.data, **{'disable-model-invocation': value})
            with self.subTest(value=value), self.assertRaises(ValueError):
                setup.validate_invocation_policy('handoff', data, policy)
        with self.assertRaisesRegex(ValueError, 'manual-only frontmatter'):
            setup.validate_invocation_policy('handoff', {'description': self.data['description']}, policy)

    def test_explicit_description_and_routine_skill_policy(self):
        with self.assertRaisesRegex(ValueError, 'Missing explicit trigger'):
            setup.validate_invocation_policy('handoff', dict(self.data, description='Always use'), None)
        with self.assertRaisesRegex(ValueError, 'Invocation policy'):
            setup.validate_invocation_policy('writing-plans', self.data, None)
        setup.validate_invocation_policy('writing-plans', {'description': 'Plan work'}, None)


if __name__ == '__main__':
    unittest.main()
