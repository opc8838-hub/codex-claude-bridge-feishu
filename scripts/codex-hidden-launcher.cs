using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

internal static class CodexHiddenLauncher
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;

    private enum JobObjectInfoType
    {
        ExtendedLimitInformation = 9
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
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
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        JobObjectInfoType infoType,
        IntPtr jobObjectInfo,
        uint jobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create Codex job object");
        }

        var limits = new JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        IntPtr limitsPtr = Marshal.AllocHGlobal(size);

        try
        {
            Marshal.StructureToPtr(limits, limitsPtr, false);
            if (!SetInformationJobObject(job, JobObjectInfoType.ExtendedLimitInformation, limitsPtr, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to configure Codex job object");
            }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(limitsPtr);
        }
    }

    private static string GetRawArguments()
    {
        string commandLine = Environment.CommandLine;
        int index;

        if (commandLine.StartsWith("\"", StringComparison.Ordinal))
        {
            index = commandLine.IndexOf('"', 1);
            index = index < 0 ? commandLine.Length : index + 1;
        }
        else
        {
            index = 0;
            while (index < commandLine.Length && !char.IsWhiteSpace(commandLine[index]))
            {
                index++;
            }
        }

        return commandLine.Substring(index).TrimStart();
    }

    private static void IgnoreTaskFailure(Task task)
    {
        try
        {
            task.Wait();
        }
        catch (AggregateException)
        {
            // The child can close a redirected stream during normal shutdown.
        }
    }

    public static int Main()
    {
        string executable = Environment.GetEnvironmentVariable("CODEX_REAL_EXECUTABLE");
        if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
        {
            Console.Error.WriteLine("CODEX_REAL_EXECUTABLE does not point to codex.exe");
            return 2;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = GetRawArguments(),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        IntPtr job = CreateKillOnCloseJob();
        try
        {
            using (Process process = Process.Start(startInfo))
            {
                if (!AssignProcessToJobObject(job, process.Handle))
                {
                    try { process.Kill(); } catch { }
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to assign Codex to job object");
                }

                Task input = Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream);
                Task output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task error = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());

                input.ContinueWith(delegate
                {
                    try { process.StandardInput.Close(); } catch { }
                });

                process.WaitForExit();
                IgnoreTaskFailure(input);
                IgnoreTaskFailure(output);
                IgnoreTaskFailure(error);
                return process.ExitCode;
            }
        }
        finally
        {
            CloseHandle(job);
        }
    }
}
