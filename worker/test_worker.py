import json
import pathlib
import tempfile
import unittest
from worker import validate_job, runner_args, assistant_text, guarded_paths, new_messages


class WorkerBoundaries(unittest.TestCase):
    def test_isolation_and_secret_boundary(self):
        args = runner_args('runner@sha256:' + 'a'*64, 'isolated-egress', '/data/jobs/example/repo', 'brokk-job-example')
        joined = ' '.join(args)
        for required in ['--read-only', '--cap-drop=ALL', 'no-new-privileges:true', '--user 1000:1000', '--pids-limit 256', '--memory 3g', '--cpus 2']:
            self.assertIn(required, joined)
        for denied in ['docker.sock', '--privileged', '--network host', 'GITHUB_TOKEN', 'WORKER_SECRET', 'DATABASE_URL', '/root', '/home/valvesss']:
            self.assertNotIn(denied, joined)
        self.assertIn('dst=/brokk-context.json,readonly', joined)
        self.assertIn('--env CURSOR_API_KEY', joined)
        self.assertNotIn('--api-key', args)
        self.assertFalse(any(arg.startswith('/home/node:') for arg in args))
        self.assertIn('HOME=/workspace/.brokk/home', args)

    def test_repository_and_preview_recipe(self):
        job = {'runId': 'a'*8+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*12, 'repository': 'cold-code-labs/nfcs', 'baseBranch': 'preview', 'profile': 'static', 'lease': 'a'*64, 'prompt': 'sealed context'}
        self.assertEqual(validate_job(job, 'cold-code-labs'), 'cold-code-labs/nfcs')
        for change in [{'repository': 'outsider/nfcs'}, {'repository': 'cold-code-labs/hauldr'}, {'baseBranch': 'main'}, {'runId': '../../secrets'}, {'lease': 'x'}]:
            with self.assertRaises(ValueError):
                validate_job({**job, **change}, 'cold-code-labs')

    def test_model_reasoning_and_tool_output_not_published(self):
        for event in [{'type': 'thinking', 'text': 'private'}, {'type': 'tool_call', 'output': 'private'}, {'type': 'assistant', 'message': {'content': [{'type': 'thinking', 'text': 'private'}]}}]:
            self.assertEqual(assistant_text(event), '')
        self.assertEqual(assistant_text({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Verificação concluída.'}]}}), 'Verificação concluída.')

    def test_guarded_delivery_and_next_turn_feedback(self):
        self.assertEqual(guarded_paths(['src/App.tsx', 'tests/a.test.ts']), [])
        self.assertEqual(len(guarded_paths(['.env.production', '.cursor/mcp.json', 'Dockerfile', 'infra/a', '.github/workflows/a.yml'])), 5)
        notes = [{'id': '1', 'category': 'question', 'body': 'Feedback'}, {'id': '2', 'category': 'decision', 'body': 'Status'}]
        self.assertEqual(new_messages(notes, set()), [notes[0]])
        self.assertEqual(new_messages(notes, {'1'}), [])

    def test_real_git_delivery_excludes_ignored_private_runtime_without_failure(self):
        from worker import Worker
        worker = object.__new__(Worker)
        with tempfile.TemporaryDirectory() as tmp:
            workspace = pathlib.Path(tmp)
            worker.git(['init'], workspace)
            (workspace / '.gitignore').write_text('.brokk/\n')
            (workspace / '.cursor').mkdir()
            (workspace / '.cursor' / 'mcp.json').write_text('{"source": "original"}')
            worker.git(['add', '.'], workspace)
            worker.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.test', 'commit', '-m', 'fixture'], workspace)
            import shutil
            shutil.rmtree(workspace / '.cursor')
            (workspace / '.brokk').mkdir()
            (workspace / '.brokk' / 'private.txt').write_text('fixture_private_runtime')
            (workspace / 'generated.txt').write_text('product change')
            worker.stage_delivery(workspace)
            self.assertEqual(worker.git(['diff', '--cached', '--name-only'], workspace), 'generated.txt')
            self.assertTrue((workspace / '.cursor' / 'mcp.json').exists())
            self.assertNotIn('fixture_private_runtime', worker.git(['diff', '--cached'], workspace))

    def test_receipt_survives_restart_without_repeating_execution(self):
        from worker import Worker
        worker = object.__new__(Worker)
        with tempfile.TemporaryDirectory() as tmp:
            worker.root = pathlib.Path(tmp)
            worker.job = {'runId': 'a'*8+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*4+'-'+ 'a'*12, 'lease': 'b'*64}
            worker.receipt('executing', sessionId='session-example')
            reports = []
            stopped = []
            worker.report = lambda **kw: reports.append(kw)
            worker.stop_container = lambda name: stopped.append(name)
            worker.recover()
            data = json.loads(next(worker.root.glob('*.json')).read_text())
            self.assertEqual(data['state'], 'failed')
            self.assertEqual(reports[0]['state'], 'failed')
            self.assertEqual(len(stopped), 1)
            self.assertIsNone(worker.job)


if __name__ == '__main__':
    unittest.main()
