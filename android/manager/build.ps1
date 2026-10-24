[CmdletBinding()]
param([string]$Platform, [string]$BuildToolsVersion, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '../build.ps1') -ProjectPath $PSScriptRoot @PSBoundParameters
