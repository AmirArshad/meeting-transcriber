"""Exercise link bootstrap failure modes in disposable checkouts, never the repo."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agent setup ')
        self.root = Path(self.temp.name)
        scripts = self.root / 'scripts/agents'
        scripts.mkdir(parents=True)
        for name in ('link_skills.sh', 'link_skills.ps1'):
            shutil.copy2(SOURCE / name, scripts / name)
        self.src = self.root / '.agents/skills/example'
        self.src.mkdir(parents=True)
        (self.src / 'SKILL.md').write_text('---\nname: example\ndescription: Example\n---\n')
        self.links = self.root / '.claude/skills'
        self.links.mkdir(parents=True)
        self.entry = self.links / 'example'
        if os.name == 'nt':
            self.command = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(scripts / 'link_skills.ps1')]
            subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        else:
            self.command = ['sh', str(scripts / 'link_skills.sh')]

    def tearDown(self):
        # Never recursively clean a junction target through its adapter path.
        if os.name == 'nt':
            for entry in self.links.iterdir():
                if getattr(entry, 'is_junction', lambda: False)(): os.rmdir(entry)
                elif entry.is_symlink(): entry.unlink()
        self.temp.cleanup()

    def run_linker(self, check=False, success=True):
        result = subprocess.run(self.command + (['--check'] if check else []), cwd=self.root,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def remove_link(self):
        if os.name == 'nt' and self.entry.is_dir() and not self.entry.is_symlink(): os.rmdir(self.entry)
        else: self.entry.unlink()

    def test_missing_idempotent_and_check(self):
        self.run_linker(check=True, success=False)
        self.run_linker()
        self.run_linker()
        self.run_linker(check=True)
        self.assertTrue(os.path.samefile(self.entry / 'SKILL.md', self.src / 'SKILL.md'))

    def test_dangling(self):
        self.run_linker()
        (self.src / 'SKILL.md').unlink()
        self.src.rmdir()
        self.run_linker(check=True, success=False)

    def test_wrong_target_and_stale(self):
        if os.name == 'nt': self.skipTest('Native link privilege required; covered separately by Windows smoke')
        self.entry.symlink_to('../../.agents/skills/missing', target_is_directory=True)
        (self.links / 'stale').symlink_to('missing', target_is_directory=True)
        (self.links / '.hidden-stale').symlink_to('missing', target_is_directory=True)
        self.run_linker(check=True, success=False)
        self.run_linker()
        self.run_linker(check=True)
        self.assertFalse((self.links / 'stale').is_symlink())
        self.assertFalse((self.links / '.hidden-stale').is_symlink())

    def test_stub(self):
        self.entry.write_text('../../.agents/skills/example')
        self.run_linker(check=True, success=False)
        self.run_linker()
        self.run_linker(check=True)

    def test_real_directory_refused(self):
        self.entry.mkdir()
        sentinel = self.entry / 'keep.txt'
        sentinel.write_text('do not delete')
        self.run_linker(success=False)
        self.assertEqual(sentinel.read_text(), 'do not delete')

    def test_near_stub_refused(self):
        self.entry.write_text('../../.agents/skills/example\n')
        self.run_linker(success=False)
        self.assertTrue(self.entry.is_file())

    def test_redirected_root_refused(self):
        if os.name == 'nt': self.skipTest('Native link privilege required')
        self.links.rmdir()
        self.links.symlink_to(self.src, target_is_directory=True)
        self.run_linker(success=False)
        self.assertTrue((self.src / 'SKILL.md').is_file())


if __name__ == '__main__':
    unittest.main()
