// Windows Job Object supervisor for weak-hardware probe browsers.
// Started by scripts/weak-hardware/windows-job.mjs through PowerShell Add-Type.
// Protocol: one JSON command per stdin line, one JSON response per stdout line.
// The job uses KILL_ON_JOB_CLOSE and never permits breakaway, so closing stdin,
// a "terminate" command or a supervisor crash ends the whole browser tree.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace PageNarrator.WeakHardware
{
    public static class JobSupervisor
    {
        const uint JOB_OBJECT_LIMIT_AFFINITY = 0x00000010;
        const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
        const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
        const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
        const int JobObjectBasicAccountingInformation = 1;
        const int JobObjectBasicProcessIdList = 3;
        const int JobObjectExtendedLimitInformation = 9;
        const int JobObjectCpuRateControlInformation = 15;
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint PROCESS_VM_READ = 0x0010;

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION
        {
            public uint ControlFlags;
            public uint CpuRate;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_MEMORY_COUNTERS_EX
        {
            public uint cb;
            public uint PageFaultCount;
            public UIntPtr PeakWorkingSetSize;
            public UIntPtr WorkingSetSize;
            public UIntPtr QuotaPeakPagedPoolUsage;
            public UIntPtr QuotaPagedPoolUsage;
            public UIntPtr QuotaPeakNonPagedPoolUsage;
            public UIntPtr QuotaNonPagedPoolUsage;
            public UIntPtr PagefileUsage;
            public UIntPtr PeakPagefileUsage;
            public UIntPtr PrivateUsage;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength, IntPtr lpReturnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool result);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment,
            string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessAffinityMask(IntPtr hProcess, out UIntPtr processMask, out UIntPtr systemMask);

        [DllImport("psapi.dll", SetLastError = true)]
        static extern bool GetProcessMemoryInfo(IntPtr hProcess, out PROCESS_MEMORY_COUNTERS_EX counters, uint size);

        static IntPtr job = IntPtr.Zero;
        static int rootPid = 0;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        public static void Run()
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            Write(Response(true, "ready", null));
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                Dictionary<string, object> result;
                try
                {
                    var command = Json.Deserialize<Dictionary<string, object>>(line);
                    result = Handle(command);
                    if (command.ContainsKey("id")) result["id"] = command["id"];
                }
                catch (Exception error)
                {
                    result = Response(false, "error", error.Message);
                }
                Write(result);
                if (result.ContainsKey("exit")) break;
            }
            TerminateBestEffort();
        }

        static Dictionary<string, object> Handle(Dictionary<string, object> command)
        {
            string cmd = Convert.ToString(command["cmd"]);
            if (cmd == "launch") return Launch(command);
            if (cmd == "query") return Query(command);
            if (cmd == "adapters") return HostInventory.Adapters();
            if (cmd == "topology") return HostInventory.Topology();
            if (cmd == "gpu-sample") return GpuCounters.Sample(job == IntPtr.Zero ? new HashSet<int>() : new HashSet<int>(ReadJobPids()));
            if (cmd == "terminate")
            {
                TerminateBestEffort();
                var response = Response(true, "terminated", null);
                response["exit"] = true;
                return response;
            }
            throw new InvalidOperationException("Unknown command: " + cmd);
        }

        static Dictionary<string, object> Launch(Dictionary<string, object> command)
        {
            if (job != IntPtr.Zero) throw new InvalidOperationException("A browser was already launched by this supervisor.");
            var limits = command.ContainsKey("limits") ? (Dictionary<string, object>)command["limits"] : new Dictionary<string, object>();
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");

            var extended = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            ulong affinity = ParseUnsigned(limits, "affinityMask");
            if (affinity != 0)
            {
                extended.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_AFFINITY;
                extended.BasicLimitInformation.Affinity = new UIntPtr(affinity);
            }
            ulong jobMemory = ParseUnsigned(limits, "jobMemoryBytes");
            if (jobMemory != 0)
            {
                extended.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                extended.JobMemoryLimit = new UIntPtr(jobMemory);
            }
            SetStruct(JobObjectExtendedLimitInformation, extended);

            ulong cpuRate = ParseUnsigned(limits, "cpuRateHundredthsPercent");
            if (cpuRate != 0)
            {
                if (cpuRate > 10000) throw new ArgumentOutOfRangeException("cpuRateHundredthsPercent");
                var rate = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION
                {
                    ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                    CpuRate = (uint)cpuRate,
                };
                SetStruct(JobObjectCpuRateControlInformation, rate);
            }

            string exe = Convert.ToString(command["exe"]);
            var args = new List<string> { Quote(exe) };
            foreach (var arg in (IEnumerable)command["args"]) args.Add(Quote(Convert.ToString(arg)));
            var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
            PROCESS_INFORMATION info;
            string cwd = command.ContainsKey("cwd") ? Convert.ToString(command["cwd"]) : null;
            if (!CreateProcessW(exe, new StringBuilder(string.Join(" ", args)), IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref startup, out info))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            }
            // The browser is assigned while suspended, so every descendant starts inside the job.
            if (!AssignProcessToJobObject(job, info.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(info.hProcess, 1);
                CloseHandle(info.hThread);
                CloseHandle(info.hProcess);
                throw new Win32Exception(error, "AssignProcessToJobObject failed");
            }
            ResumeThread(info.hThread);
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            rootPid = info.dwProcessId;
            var response = Response(true, "launched", null);
            response["pid"] = rootPid;
            response["limits"] = ReadLimits();
            return response;
        }

        static Dictionary<string, object> Query(Dictionary<string, object> command)
        {
            if (job == IntPtr.Zero) throw new InvalidOperationException("No browser has been launched.");
            var response = Response(true, "query", null);
            response["rootPid"] = rootPid;
            response["limits"] = ReadLimits();
            response["accounting"] = ReadAccounting();
            var jobPids = ReadJobPids();
            response["jobPids"] = jobPids;
            string match = command.ContainsKey("matchCommandLine") ? Convert.ToString(command["matchCommandLine"]) : null;
            response["browserProcesses"] = DescribeBrowserTree(match, new HashSet<int>(jobPids));
            return response;
        }

        static Dictionary<string, object> ReadLimits()
        {
            var extended = GetStruct<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(JobObjectExtendedLimitInformation);
            var rate = GetStruct<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>(JobObjectCpuRateControlInformation);
            var limits = new Dictionary<string, object>();
            limits["limitFlags"] = extended.BasicLimitInformation.LimitFlags;
            limits["affinityMask"] = extended.BasicLimitInformation.Affinity.ToUInt64().ToString();
            limits["jobMemoryLimitBytes"] = extended.JobMemoryLimit.ToUInt64().ToString();
            limits["peakJobMemoryUsedBytes"] = extended.PeakJobMemoryUsed.ToUInt64().ToString();
            limits["peakProcessMemoryUsedBytes"] = extended.PeakProcessMemoryUsed.ToUInt64().ToString();
            limits["killOnJobClose"] = (extended.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) != 0;
            limits["cpuRateControlFlags"] = rate.ControlFlags;
            limits["cpuRateHundredthsPercent"] = rate.CpuRate;
            return limits;
        }

        static Dictionary<string, object> ReadAccounting()
        {
            var accounting = GetStruct<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(JobObjectBasicAccountingInformation);
            var result = new Dictionary<string, object>();
            result["totalUserTime100ns"] = accounting.TotalUserTime.ToString();
            result["totalKernelTime100ns"] = accounting.TotalKernelTime.ToString();
            result["totalProcesses"] = accounting.TotalProcesses;
            result["activeProcesses"] = accounting.ActiveProcesses;
            result["totalTerminatedProcesses"] = accounting.TotalTerminatedProcesses;
            result["queriedAtUtc"] = DateTime.UtcNow.ToString("o");
            return result;
        }

        static List<int> ReadJobPids()
        {
            int capacity = 4096;
            int size = 8 + IntPtr.Size * capacity;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Query process list failed");
                }
                int count = Marshal.ReadInt32(buffer, 4);
                var pids = new List<int>();
                for (int index = 0; index < count; index += 1)
                {
                    pids.Add((int)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
                }
                return pids;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        static List<object> DescribeBrowserTree(string matchCommandLine, HashSet<int> jobPids)
        {
            var parents = new Dictionary<int, int>();
            var names = new Dictionary<int, string>();
            var matches = new HashSet<int>();
            using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process"))
            {
                foreach (ManagementObject process in searcher.Get())
                {
                    int pid = Convert.ToInt32(process["ProcessId"]);
                    parents[pid] = Convert.ToInt32(process["ParentProcessId"]);
                    names[pid] = Convert.ToString(process["Name"]);
                    string commandLine = Convert.ToString(process["CommandLine"]);
                    if (!string.IsNullOrEmpty(matchCommandLine) && commandLine != null
                        && commandLine.IndexOf(matchCommandLine, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        matches.Add(pid);
                    }
                    process.Dispose();
                }
            }
            var tree = new HashSet<int>(matches);
            if (rootPid != 0 && names.ContainsKey(rootPid)) tree.Add(rootPid);
            bool changed = true;
            while (changed)
            {
                changed = false;
                foreach (var entry in parents)
                {
                    if (!tree.Contains(entry.Key) && tree.Contains(entry.Value) && entry.Key != entry.Value)
                    {
                        tree.Add(entry.Key);
                        changed = true;
                    }
                }
            }
            foreach (int pid in jobPids) tree.Add(pid);
            var described = new List<object>();
            foreach (int pid in tree)
            {
                var entry = new Dictionary<string, object>();
                entry["pid"] = pid;
                entry["name"] = names.ContainsKey(pid) ? names[pid] : null;
                entry["parentPid"] = parents.ContainsKey(pid) ? (object)parents[pid] : null;
                entry["listedInJob"] = jobPids.Contains(pid);
                entry["commandLineMatched"] = matches.Contains(pid);
                IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
                if (handle == IntPtr.Zero) handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (handle == IntPtr.Zero)
                {
                    entry["openError"] = Marshal.GetLastWin32Error();
                }
                else
                {
                    try
                    {
                        bool inJob;
                        entry["inJob"] = IsProcessInJob(handle, job, out inJob) ? (object)inJob : null;
                        UIntPtr processMask;
                        UIntPtr systemMask;
                        if (GetProcessAffinityMask(handle, out processMask, out systemMask))
                        {
                            entry["affinityMask"] = processMask.ToUInt64().ToString();
                            entry["systemAffinityMask"] = systemMask.ToUInt64().ToString();
                        }
                        PROCESS_MEMORY_COUNTERS_EX counters;
                        if (GetProcessMemoryInfo(handle, out counters, (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS_EX))))
                        {
                            entry["privateBytes"] = counters.PrivateUsage.ToUInt64().ToString();
                            entry["workingSetBytes"] = counters.WorkingSetSize.ToUInt64().ToString();
                            entry["peakWorkingSetBytes"] = counters.PeakWorkingSetSize.ToUInt64().ToString();
                        }
                    }
                    finally
                    {
                        CloseHandle(handle);
                    }
                }
                described.Add(entry);
            }
            return described;
        }

        static void TerminateBestEffort()
        {
            if (job == IntPtr.Zero) return;
            TerminateJobObject(job, 1);
            CloseHandle(job);
            job = IntPtr.Zero;
        }

        static void SetStruct<T>(int infoClass, T value)
        {
            int size = Marshal.SizeOf(typeof(T));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(value, buffer, false);
                if (!SetInformationJobObject(job, infoClass, buffer, (uint)size))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(" + infoClass + ") failed");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        static T GetStruct<T>(int infoClass)
        {
            int size = Marshal.SizeOf(typeof(T));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryInformationJobObject(job, infoClass, buffer, (uint)size, IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject(" + infoClass + ") failed");
                }
                return (T)Marshal.PtrToStructure(buffer, typeof(T));
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        static ulong ParseUnsigned(Dictionary<string, object> values, string key)
        {
            if (!values.ContainsKey(key) || values[key] == null) return 0;
            string raw = Convert.ToString(values[key]).Trim();
            if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                return Convert.ToUInt64(raw.Substring(2), 16);
            }
            return Convert.ToUInt64(raw);
        }

        // CommandLineToArgvW-compatible quoting.
        static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            var builder = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    slashes += 1;
                    continue;
                }
                if (character == '"')
                {
                    builder.Append('\\', slashes * 2 + 1);
                }
                else
                {
                    builder.Append('\\', slashes);
                }
                slashes = 0;
                builder.Append(character);
            }
            builder.Append('\\', slashes * 2);
            builder.Append('"');
            return builder.ToString();
        }

        internal static Dictionary<string, object> Response(bool ok, string kind, string error)
        {
            var response = new Dictionary<string, object>();
            response["ok"] = ok;
            response["kind"] = kind;
            if (error != null) response["error"] = error;
            return response;
        }

        static void Write(Dictionary<string, object> response)
        {
            Console.Out.WriteLine(Json.Serialize(response));
            Console.Out.Flush();
        }
    }

    // Read-only host inventory: physical adapters (DXGI) and CPU core classes.
    public static class HostInventory
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct DXGI_ADAPTER_DESC1
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
            public uint VendorId;
            public uint DeviceId;
            public uint SubSysId;
            public uint Revision;
            public UIntPtr DedicatedVideoMemory;
            public UIntPtr DedicatedSystemMemory;
            public UIntPtr SharedSystemMemory;
            public uint LuidLowPart;
            public int LuidHighPart;
            public uint Flags;
        }

        [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IDXGIAdapter1
        {
            void SetPrivateData();
            void SetPrivateDataInterface();
            void GetPrivateData();
            void GetParent();
            void EnumOutputs();
            void GetDesc();
            void CheckInterfaceSupport();
            [PreserveSig] int GetDesc1(out DXGI_ADAPTER_DESC1 desc);
        }

        [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IDXGIFactory1
        {
            void SetPrivateData();
            void SetPrivateDataInterface();
            void GetPrivateData();
            void GetParent();
            void EnumAdapters();
            void MakeWindowAssociation();
            void GetWindowAssociation();
            void CreateSwapChain();
            void CreateSoftwareAdapter();
            [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
            [PreserveSig] bool IsCurrent();
        }

        [DllImport("dxgi.dll")]
        static extern int CreateDXGIFactory1(ref Guid riid, out IDXGIFactory1 factory);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetLogicalProcessorInformationEx(int relationship, IntPtr buffer, ref uint length);

        public static Dictionary<string, object> Adapters()
        {
            var response = JobSupervisor.Response(true, "adapters", null);
            var adapters = new List<object>();
            var adapterErrors = new List<string>();
            bool enumerationComplete = false;
            Guid iid = typeof(IDXGIFactory1).GUID;
            IDXGIFactory1 factory;
            int hr = CreateDXGIFactory1(ref iid, out factory);
            if (hr != 0) throw new InvalidOperationException("CreateDXGIFactory1 failed: 0x" + hr.ToString("x8"));
            for (uint index = 0; ; index += 1)
            {
                IDXGIAdapter1 adapter;
                int enumResult = factory.EnumAdapters1(index, out adapter);
                if (enumResult == unchecked((int)0x887A0002)) { enumerationComplete = true; break; }
                if (enumResult != 0) { adapterErrors.Add("EnumAdapters1[" + index + "]: 0x" + enumResult.ToString("x8")); break; }
                DXGI_ADAPTER_DESC1 desc;
                int descResult = adapter.GetDesc1(out desc);
                if (descResult != 0) { adapterErrors.Add("GetDesc1[" + index + "]: 0x" + descResult.ToString("x8")); continue; }
                var entry = new Dictionary<string, object>();
                entry["index"] = index;
                entry["description"] = desc.Description;
                entry["vendorId"] = desc.VendorId;
                entry["deviceId"] = desc.DeviceId;
                entry["dedicatedVideoMemoryBytes"] = desc.DedicatedVideoMemory.ToUInt64().ToString();
                entry["sharedSystemMemoryBytes"] = desc.SharedSystemMemory.ToUInt64().ToString();
                entry["luidHigh"] = desc.LuidHighPart;
                entry["luidLow"] = desc.LuidLowPart;
                entry["software"] = (desc.Flags & 2) != 0;
                adapters.Add(entry);
            }
            response["adapters"] = adapters;
            response["adaptersComplete"] = enumerationComplete && adapterErrors.Count == 0;
            response["adapterErrors"] = adapterErrors;
            return response;
        }

        public static Dictionary<string, object> Topology()
        {
            const int RelationProcessorCore = 0;
            uint length = 0;
            GetLogicalProcessorInformationEx(RelationProcessorCore, IntPtr.Zero, ref length);
            IntPtr buffer = Marshal.AllocHGlobal((int)length);
            try
            {
                if (!GetLogicalProcessorInformationEx(RelationProcessorCore, buffer, ref length))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetLogicalProcessorInformationEx failed");
                }
                var processors = new List<object>();
                int offset = 0;
                int core = 0;
                while (offset < length)
                {
                    int size = Marshal.ReadInt32(buffer, offset + 4);
                    byte efficiencyClass = Marshal.ReadByte(buffer, offset + 9);
                    int groupCount = Marshal.ReadInt16(buffer, offset + 30);
                    for (int group = 0; group < groupCount; group += 1)
                    {
                        long mask = Marshal.ReadInt64(buffer, offset + 32 + group * 16);
                        int groupNumber = Marshal.ReadInt16(buffer, offset + 40 + group * 16);
                        for (int bit = 0; bit < 64; bit += 1)
                        {
                            if ((mask & (1L << bit)) == 0) continue;
                            var entry = new Dictionary<string, object>();
                            entry["logicalProcessor"] = groupNumber * 64 + bit;
                            entry["core"] = core;
                            entry["efficiencyClass"] = (int)efficiencyClass;
                            processors.Add(entry);
                        }
                    }
                    core += 1;
                    offset += size;
                }
                var response = JobSupervisor.Response(true, "topology", null);
                response["processors"] = processors;
                return response;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    // GPU engine running time and GPU process memory, split by adapter LUID into
    // the supervised browser tree ("job") and every other process ("foreign").
    public static class GpuCounters
    {
        public static Dictionary<string, object> Sample(HashSet<int> jobPids)
        {
            var response = JobSupervisor.Response(true, "gpu-sample", null);
            response["sampledAtUtc"] = DateTime.UtcNow.ToString("o");
            response["timestamp100ns"] = DateTime.UtcNow.Ticks.ToString();
            var engines = new Dictionary<string, long[]>();
            var engineInstances = new List<object>();
            bool engineInstancesComplete = false;
            try
            {
                var data = new PerformanceCounterCategory("GPU Engine").ReadCategory();
                var runningTime = data["Running Time"];
                if (runningTime != null)
                {
                    engineInstancesComplete = true;
                    foreach (InstanceData sample in runningTime.Values)
                    {
                        if (string.Equals(sample.InstanceName, "_Total", StringComparison.OrdinalIgnoreCase)) continue;
                        int pid;
                        string luid;
                        string engineType;
                        bool parsed = ParseInstance(sample.InstanceName, out pid, out luid, out engineType);
                        string engineId = ParseEngineId(sample.InstanceName);
                        var instance = new Dictionary<string, object>();
                        instance["instanceName"] = sample.InstanceName;
                        instance["pid"] = parsed ? (object)pid : null;
                        instance["luid"] = luid;
                        instance["engineId"] = engineId;
                        instance["engineType"] = engineType;
                        instance["isJob"] = parsed ? (object)jobPids.Contains(pid) : null;
                        instance["runningTime100ns"] = sample.RawValue.ToString();
                        engineInstances.Add(instance);
                        if (!parsed || pid < 0 || engineId == null || sample.RawValue < 0)
                        {
                            // Known-adapter bad values stay raw and invalidate
                            // that adapter in the paired consumer, not others.
                            if (!parsed || string.IsNullOrEmpty(luid)) engineInstancesComplete = false;
                            continue;
                        }
                        string key = luid + "|" + engineType;
                        if (!engines.ContainsKey(key)) engines[key] = new long[2];
                        engines[key][jobPids.Contains(pid) ? 0 : 1] += sample.RawValue;
                    }
                }
                response["engines"] = Flatten(engines, "jobRunningTime100ns", "foreignRunningTime100ns");
            }
            catch (Exception error)
            {
                engineInstancesComplete = false;
                response["enginesError"] = error.Message;
            }
            response["engineInstances"] = engineInstances;
            response["engineInstancesComplete"] = engineInstancesComplete;
            var memory = new Dictionary<string, long[]>();
            try
            {
                var data = new PerformanceCounterCategory("GPU Process Memory").ReadCategory();
                var dedicated = data["Dedicated Usage"];
                var shared = data["Shared Usage"];
                AddMemory(memory, dedicated, jobPids, 0);
                AddMemory(memory, shared, jobPids, 2);
                var list = new List<object>();
                foreach (var entry in memory)
                {
                    var item = new Dictionary<string, object>();
                    item["luid"] = entry.Key;
                    item["jobDedicatedBytes"] = entry.Value[0].ToString();
                    item["foreignDedicatedBytes"] = entry.Value[1].ToString();
                    item["jobSharedBytes"] = entry.Value[2].ToString();
                    item["foreignSharedBytes"] = entry.Value[3].ToString();
                    list.Add(item);
                }
                response["memory"] = list;
            }
            catch (Exception error)
            {
                response["memoryError"] = error.Message;
            }
            return response;
        }

        static void AddMemory(Dictionary<string, long[]> memory, InstanceDataCollection samples, HashSet<int> jobPids, int offset)
        {
            if (samples == null) return;
            foreach (InstanceData sample in samples.Values)
            {
                int pid;
                string luid;
                string ignored;
                if (!ParseInstance(sample.InstanceName, out pid, out luid, out ignored)) continue;
                if (!memory.ContainsKey(luid)) memory[luid] = new long[4];
                memory[luid][offset + (jobPids.Contains(pid) ? 0 : 1)] += sample.RawValue;
            }
        }

        static List<object> Flatten(Dictionary<string, long[]> values, string jobKey, string foreignKey)
        {
            var list = new List<object>();
            foreach (var entry in values)
            {
                var parts = entry.Key.Split('|');
                var item = new Dictionary<string, object>();
                item["luid"] = parts[0];
                item["engineType"] = parts[1];
                item[jobKey] = entry.Value[0].ToString();
                item[foreignKey] = entry.Value[1].ToString();
                list.Add(item);
            }
            return list;
        }

        // Instance names look like pid_1234_luid_0x00000000_0x0001A821_phys_0_eng_3_engtype_Compute.
        // Display types may be empty. Physical/index identity names the engine;
        // GPU Process Memory instances do not have these fields.
        static string ParseEngineId(string name)
        {
            var parts = name.Split('_');
            int physicalIndex = Array.IndexOf(parts, "phys");
            int engineIndex = Array.IndexOf(parts, "eng");
            int physical;
            int engine;
            if (physicalIndex < 0 || physicalIndex + 1 >= parts.Length || engineIndex < 0 || engineIndex + 1 >= parts.Length
                || !int.TryParse(parts[physicalIndex + 1], out physical) || physical < 0
                || !int.TryParse(parts[engineIndex + 1], out engine) || engine < 0) return null;
            return "phys_" + physical + "_eng_" + engine;
        }

        static bool ParseInstance(string name, out int pid, out string luid, out string engineType)
        {
            pid = 0;
            luid = null;
            engineType = "";
            var parts = name.Split('_');
            if (parts.Length < 5 || parts[0] != "pid" || parts[2] != "luid") return false;
            if (!int.TryParse(parts[1], out pid)) return false;
            uint high;
            uint low;
            if (parts[3].Length != 10 || parts[4].Length != 10
                || !parts[3].StartsWith("0x", StringComparison.OrdinalIgnoreCase) || !parts[4].StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                || !uint.TryParse(parts[3].Substring(2), System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out high)
                || !uint.TryParse(parts[4].Substring(2), System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out low)) return false;
            luid = parts[3] + "_" + parts[4];
            int typeIndex = Array.IndexOf(parts, "engtype");
            if (typeIndex >= 0 && typeIndex + 1 < parts.Length) engineType = string.Join("_", parts, typeIndex + 1, parts.Length - typeIndex - 1);
            return true;
        }
    }
}
