import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { JOB_SUPERVISOR_SOURCE } from '../../scripts/weak-hardware/windows-job.mjs';

it.skipIf(process.platform !== 'win32')('compiles the supervisor and rejects impossible parent-PID reuse without dropping unknown times', () => {
  const sourcePath = JOB_SUPERVISOR_SOURCE.replaceAll("'", "''");
  const checks = `
namespace PageNarrator.WeakHardware {
  public static class AncestryChecks {
    public static void Run() {
      var method = typeof(JobSupervisor).GetMethod("IsPossibleChild", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
      var created = new System.Collections.Generic.Dictionary<int, System.DateTime>();
      created.Add(1, new System.DateTime(2026, 10, 30, 10, 22, 55));
      created.Add(2, new System.DateTime(2026, 10, 31, 18, 0, 0));
      created.Add(3, new System.DateTime(2026, 10, 31, 18, 0, 1));
      created.Add(4, new System.DateTime(2026, 10, 31, 18, 0, 0));
      int[] children = { 1, 3, 4, 5, 3 }, parents = { 2, 2, 2, 2, 5 };
      bool[] expected = { false, true, true, true, true };
      for (int i = 0; i < children.Length; i++) {
        bool actual = (bool)method.Invoke(null, new object[] { children[i], parents[i], created });
        if (actual != expected[i]) throw new System.Exception("Process creation-time ancestry regression");
      }
    }
  }
}`;
  const script = `$ErrorActionPreference='Stop'; $source=[IO.File]::ReadAllText('${sourcePath}'); $source+=@'
${checks}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Management,System.Web.Extensions; [PageNarrator.WeakHardware.AncestryChecks]::Run(); Write-Output '5 ancestry checks passed'`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  expect(output).toContain('5 ancestry checks passed');
});
