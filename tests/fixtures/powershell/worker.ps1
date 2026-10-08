[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$Bridge,
    [string]$Credential,
    [string]$Token,
    [string]$EchoTopic,
    [int]$TimeoutMs = 10000,
    [int]$MaxFrameBytes = 4194304
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sdkDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../sdk/powershell'))
if (-not ('WorldHub.Phase7.ProtocolWorker' -as [type])) {
    Add-Type -LiteralPath @((Join-Path $sdkDirectory 'HubBridge.cs'), (Join-Path $PSScriptRoot 'ProtocolWorker.cs'))
}
Import-Module (Join-Path $sdkDirectory 'HubBridge.psm1') -Force
exit [WorldHub.Phase7.ProtocolWorker]::RunAsync($Url, $Bridge, $Credential, $Token, $EchoTopic, $PSVersionTable.PSVersion.ToString(), $TimeoutMs, $MaxFrameBytes).GetAwaiter().GetResult()
