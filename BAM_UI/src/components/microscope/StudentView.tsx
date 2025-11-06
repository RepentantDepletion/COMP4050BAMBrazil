import { useEffect, useState } from "react";
import { Card, CardContent } from "@components/ui/card";
import { Label } from "@components/ui/label";
import { Input } from "@components/ui/input";
import { Button } from "@components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@components/ui/select";
import { useMicroscope } from "@hooks/useMicroscope";
import { MicroscopeAPI, ImagesAPI } from "@/services/apiClient";

export default function StudentView({ selectedBioscope, onSelectBioscope }: { selectedBioscope: string; onSelectBioscope: (id: string) => void }) {
	const { bioscopes, selectedBioscope: hookSelected, setSelectedBioscope } = useMicroscope();
	const [status, setStatus] = useState<any | null>(null);
	const [loadingStatus, setLoadingStatus] = useState(false);
	const [sessionId, setSessionId] = useState<string>("");
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [lastImageMeta, setLastImageMeta] = useState<any | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		// keep parent and hook selection in sync
		if (selectedBioscope && selectedBioscope !== hookSelected) setSelectedBioscope(selectedBioscope);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedBioscope]);

	useEffect(() => {
		// whenever hook selection changes inform parent
		onSelectBioscope(hookSelected);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hookSelected]);

	useEffect(() => {
		let mounted = true;
		async function loadStatus() {
			try {
				setLoadingStatus(true);
				const s = await MicroscopeAPI.status(hookSelected);
				if (!mounted) return;
				setStatus(s);
			} catch (err) {
				setStatus(null);
			} finally {
				setLoadingStatus(false);
			}
		}
		if (hookSelected) void loadStatus();
		const iv = setInterval(() => { if (hookSelected) void loadStatus(); }, 5000);
		return () => { mounted = false; clearInterval(iv); };
	}, [hookSelected]);

	useEffect(() => {
		return () => {
			if (imageUrl) URL.revokeObjectURL(imageUrl);
		};
	}, [imageUrl]);

	async function doCommand(cmd: string, params?: Record<string, unknown>) {
		setBusy(true);
		try {
			await MicroscopeAPI.command(hookSelected, cmd, params);
			// refresh status
			const s = await MicroscopeAPI.status(hookSelected);
			setStatus(s);
		} catch (err) {
			// ignore — UI should stay responsive and show nothing on error for now
			console.warn("microscope command failed", err);
		} finally {
			setBusy(false);
		}
	}

	async function doCapture() {
		if (!sessionId) {
			alert("Enter your session UUID before capturing an image.");
			return;
		}
		setBusy(true);
		try {
			const meta = await MicroscopeAPI.capture(hookSelected, { session_id: sessionId, auto_focus: true, quality: "high", format: "jpeg" });
			setLastImageMeta(meta);
			// fetch raw file blob and create URL
			try {
				// backend may return `image_id` or `id`.
				const imageId = String((meta as any).image_id ?? (meta as any).id ?? (meta as any).imageId);
				const blob = await ImagesAPI.getFile(imageId);
				const url = URL.createObjectURL(blob);
				if (imageUrl) URL.revokeObjectURL(imageUrl);
				setImageUrl(url);
			} catch (err) {
				console.warn("failed to load image file", err);
			}
		} catch (err) {
			console.warn("capture failed", err);
			alert("Failed to capture image.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="border-0 shadow-sm">
			<CardContent>
				<div className="flex flex-col gap-4">
					{/* Top row: bioscope selector and session id - keep compact */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
						<div>
							<Label>Bioscope</Label>
							<Select value={hookSelected} onValueChange={(v: string) => setSelectedBioscope(v)}>
								<SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
								<SelectContent>
									{bioscopes.map((b) => (
										<SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div>
							<Label>Session UUID</Label>
							<Input value={sessionId} onChange={(e) => setSessionId(e.target.value)} className="mt-1" placeholder="your-session-uuid" />
						</div>

						<div className="flex gap-2">
							<Button variant="outline" onClick={() => doCommand("Focus") } disabled={busy}>Auto-focus</Button>
							<Button onClick={doCapture} disabled={busy}>Capture</Button>
						</div>
					</div>

					{/* Main area: controls column on the left, image on the right */}
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
						<div className="md:col-span-1">
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-2">
									<Label className="text-sm">Movement</Label>
									<div className="flex flex-col items-center gap-2">
										<div className="flex gap-2">
											<Button variant="ghost" onClick={() => doCommand("move", { x: 0, y: -10 })} disabled={busy}>▲</Button>
										</div>
										<div className="flex gap-2">
											<Button variant="ghost" onClick={() => doCommand("move", { x: -10, y: 0 })} disabled={busy}>◀</Button>
											<Button variant="ghost" onClick={() => doCommand("move", { x: 10, y: 0 })} disabled={busy}>▶</Button>
										</div>
										<div className="flex gap-2">
											<Button variant="ghost" onClick={() => doCommand("move", { x: 0, y: 10 })} disabled={busy}>▼</Button>
										</div>
									</div>
								</div>

								<div className="flex flex-col gap-2">
									<Label className="text-sm">Zoom & Tracking</Label>
									<div className="flex flex-col gap-2">
										<Button variant="ghost" onClick={() => doCommand("zoom", { delta: 1 })} disabled={busy}>Zoom +</Button>
										<Button variant="ghost" onClick={() => doCommand("zoom", { delta: -1 })} disabled={busy}>Zoom −</Button>
										<Button variant="ghost" onClick={() => doCommand("start_tracking")} disabled={busy}>Start Tracking</Button>
										<Button variant="ghost" onClick={() => doCommand("stop_tracking")} disabled={busy}>Stop Tracking</Button>
									</div>
								</div>

								<div>
									<Label className="text-sm">Status</Label>
									<div className="mt-1 text-sm text-slate-600">
										{loadingStatus ? "Loading…" : status ? (
											<pre className="whitespace-pre-wrap text-xs">{JSON.stringify(status, null, 2)}</pre>
										) : "No status available"}
									</div>
								</div>
							</div>
						</div>

						<div className="md:col-span-2">
							<Label>Latest capture</Label>
							<div className="mt-1 bg-slate-50 rounded-md p-2 flex items-center justify-center">
								{(() => {
									const SAMPLE_PATH = "/sample2.svg";
									const src = imageUrl ?? SAMPLE_PATH;
									const alt = lastImageMeta?.filename ?? (imageUrl ? "capture" : "sample image");
									return (
										<img src={src} alt={alt} className="rounded-md w-full h-[420px] object-contain" />
									);
								})()}
							</div>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
