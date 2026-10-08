Set-StrictMode -Version Latest

if (-not ('WorldHub.Phase7.HubBridge' -as [type])) {
    Add-Type -LiteralPath (Join-Path $PSScriptRoot 'HubBridge.cs')
}

function New-HubBridge {
    [CmdletBinding()]
    param([int]$MaxFrameBytes = 4194304, [long]$MaxBufferedBytes = 8388608)
    [WorldHub.Phase7.HubBridge]::new($MaxFrameBytes, $MaxBufferedBytes)
}

function Connect-HubBridge {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bridge, [Parameter(Mandatory)][string]$Url, [int]$TimeoutMs = 10000)
    $Bridge.ConnectAsync($Url, $TimeoutMs).GetAwaiter().GetResult()
}

function Send-HubBridgeRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bridge, [Parameter(Mandatory)][string]$Raw, [int]$TimeoutMs = 10000)
    $Bridge.SendRawAsync($Raw, $TimeoutMs).GetAwaiter().GetResult()
}

function Receive-HubBridgeRaw {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bridge, [int]$TimeoutMs = 10000)
    $Bridge.ReceiveRawAsync($TimeoutMs).GetAwaiter().GetResult()
}

function Close-HubBridge {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bridge, [int]$TimeoutMs = 2000)
    $Bridge.CloseAsync($TimeoutMs).GetAwaiter().GetResult()
}

Export-ModuleMember -Function New-HubBridge, Connect-HubBridge, Send-HubBridgeRaw, Receive-HubBridgeRaw, Close-HubBridge
