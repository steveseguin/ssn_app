param(
	[Parameter(Mandatory = $true)]
	[string]$StopFile,
	[Parameter(Mandatory = $true)]
	[int]$TargetProcessId,
	[int]$MaxDurationMs = 60000,
	[int]$SampleIntervalMs = 10,
	[int]$BaselineDurationMs = 500
)

$ErrorActionPreference = "Stop"

$coreAudioSource = @'
using System;
using System.Runtime.InteropServices;

public enum EDataFlow { eRender, eCapture, eAll }
public enum ERole { eConsole, eMultimedia, eCommunications }

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
	int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out object devices);
	int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
	int Activate(ref Guid iid, uint classContext, IntPtr activationParameters,
		[MarshalAs(UnmanagedType.IUnknown)] out object instance);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
	int GetAudioSessionControl(IntPtr sessionGuid, uint streamFlags, out object sessionControl);
	int GetSimpleAudioVolume(IntPtr sessionGuid, uint streamFlags, out object simpleAudioVolume);
	int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
	int GetCount(out int sessionCount);
	int GetSession(int sessionIndex, out IAudioSessionControl sessionControl);
}

public enum AudioSessionState { Inactive, Active, Expired }

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
	int GetState(out AudioSessionState state);
	int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
	int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, IntPtr eventContext);
	int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
	int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, IntPtr eventContext);
	int GetGroupingParam(out Guid groupingId);
	int SetGroupingParam(ref Guid groupingId, IntPtr eventContext);
	int RegisterAudioSessionNotification(IntPtr client);
	int UnregisterAudioSessionNotification(IntPtr client);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
	int GetState(out AudioSessionState state);
	int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
	int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, IntPtr eventContext);
	int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
	int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, IntPtr eventContext);
	int GetGroupingParam(out Guid groupingId);
	int SetGroupingParam(ref Guid groupingId, IntPtr eventContext);
	int RegisterAudioSessionNotification(IntPtr client);
	int UnregisterAudioSessionNotification(IntPtr client);
	int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);
	int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionInstanceIdentifier);
	int GetProcessId(out uint processId);
	int IsSystemSoundsSession();
	int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation {
	int GetPeakValue(out float peak);
	int GetMeteringChannelCount(out int channelCount);
	int GetChannelsPeakValues(int channelCount,
		[Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
	int QueryHardwareSupport(out int hardwareSupportMask);
}

public sealed class WindowsAudioPeakMeter {
	private readonly IAudioSessionManager2 sessionManager;
	private readonly IAudioMeterInformation endpointMeter;
	private readonly int processId;
	private readonly string processName;

	public WindowsAudioPeakMeter(int processId) {
		this.processId = processId;
		try {
			this.processName = System.Diagnostics.Process.GetProcessById(processId).ProcessName;
		} catch {
			this.processName = "";
		}
		var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
		IMMDevice endpoint;
		Marshal.ThrowExceptionForHR(
			enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out endpoint)
		);
		var interfaceId = typeof(IAudioSessionManager2).GUID;
		object instance;
		Marshal.ThrowExceptionForHR(endpoint.Activate(ref interfaceId, 23, IntPtr.Zero, out instance));
		sessionManager = (IAudioSessionManager2)instance;
		interfaceId = typeof(IAudioMeterInformation).GUID;
		Marshal.ThrowExceptionForHR(endpoint.Activate(ref interfaceId, 23, IntPtr.Zero, out instance));
		endpointMeter = (IAudioMeterInformation)instance;
	}

	public float Peak {
		get {
			if (processId == 0) {
				float endpointValue;
				Marshal.ThrowExceptionForHR(endpointMeter.GetPeakValue(out endpointValue));
				return endpointValue;
			}
			IAudioSessionEnumerator sessions;
			Marshal.ThrowExceptionForHR(sessionManager.GetSessionEnumerator(out sessions));
			int count;
			Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
			float maximum = 0;
			for (int index = 0; index < count; index++) {
				IAudioSessionControl control;
				if (sessions.GetSession(index, out control) != 0 || control == null) continue;
				var control2 = control as IAudioSessionControl2;
				if (control2 == null) continue;
				uint sessionProcessId;
				int processResult = control2.GetProcessId(out sessionProcessId);
				if (processResult < 0 || !MatchesProcess(sessionProcessId)) continue;
				var sessionMeter = control as IAudioMeterInformation;
				if (sessionMeter == null) continue;
				float value;
				if (sessionMeter.GetPeakValue(out value) == 0 && value > maximum) maximum = value;
			}
			return maximum;
		}
	}

	private bool MatchesProcess(uint sessionProcessId) {
		if (sessionProcessId == processId) return true;
		if (String.IsNullOrWhiteSpace(processName)) return false;
		try {
			return String.Equals(
				System.Diagnostics.Process.GetProcessById((int)sessionProcessId).ProcessName,
				processName,
				StringComparison.OrdinalIgnoreCase
			);
		} catch {
			return false;
		}
	}
}
'@

Add-Type -TypeDefinition $coreAudioSource
$meter = New-Object WindowsAudioPeakMeter($TargetProcessId)

function Measure-PeakUntil([DateTime]$deadline) {
	$maximum = 0.0
	$activeSamples = 0
	$samples = 0
	while ([DateTime]::UtcNow -lt $deadline) {
		$peak = [double]$meter.Peak
		if ($peak -gt $maximum) { $maximum = $peak }
		if ($peak -gt 0.002) { $activeSamples++ }
		$samples++
		Start-Sleep -Milliseconds $SampleIntervalMs
	}
	return [pscustomobject]@{
		maxPeak = $maximum
		activeSamples = $activeSamples
		samples = $samples
	}
}

$baseline = Measure-PeakUntil ([DateTime]::UtcNow.AddMilliseconds($BaselineDurationMs))
Write-Output "READY"
[Console]::Out.Flush()

$maximum = 0.0
$activeSamples = 0
$samples = 0
$started = [DateTime]::UtcNow
$deadline = $started.AddMilliseconds($MaxDurationMs)

while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $StopFile)) {
	$peak = [double]$meter.Peak
	if ($peak -gt $maximum) { $maximum = $peak }
	if ($peak -gt 0.002) { $activeSamples++ }
	$samples++
	Start-Sleep -Milliseconds $SampleIntervalMs
}

[pscustomobject]@{
	baselineMaxPeak = $baseline.maxPeak
	baselineActiveSamples = $baseline.activeSamples
	maxPeak = $maximum
	activeSamples = $activeSamples
	samples = $samples
	durationMs = [Math]::Round(([DateTime]::UtcNow - $started).TotalMilliseconds)
	timedOut = -not (Test-Path -LiteralPath $StopFile)
} | ConvertTo-Json -Compress
