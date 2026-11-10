param(
  [ValidateSet('Run', 'Probe', 'Cleanup')][string]$Mode,
  [string]$PipeName,
  [string]$JobName
)
$ErrorActionPreference = 'Stop'
try {
  Import-Module ([System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'))
  # Compile the packaged, fixed helper in memory. No downloaded binary, compiler
  # installation, profile, persistent policy change or model execution is needed.
  Add-Type -Path ([System.IO.Path]::Combine($PSScriptRoot, 'windows-job.cs')) -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
  $result = [Mlswarm.WindowsJob]::Run($Mode, $PipeName, $JobName)
  exit $result
} catch {
  [Console]::Error.WriteLine('Windows worker supervision is unavailable. No cleanup success is implied.')
  exit 1
}
