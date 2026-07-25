using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class CodexHiddenLauncher
{
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

        using (Process process = Process.Start(startInfo))
        {
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
}
