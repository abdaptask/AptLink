// Web Audio mixing graph manager for client-side 3-way conference and hold music
export interface ConferenceParticipant {
  id: string;
  pc: RTCPeerConnection;
}

export class AudioGraphService {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private participants: Map<
    string,
    {
      sourceNode: MediaStreamAudioSourceNode;
      destNode: MediaStreamAudioDestinationNode;
      otherDests: MediaStreamAudioDestinationNode[];
      muted: boolean;
    }
  > = new Map();

  private holdMusics: Map<
    string,
    {
      audioEl: HTMLAudioElement;
      ctx: AudioContext;
      dest: MediaStreamAudioDestinationNode;
    }
  > = new Map();

  async startConference(
    participantList: ConferenceParticipant[],
    constraints: MediaTrackConstraints
  ): Promise<boolean> {
    try {
      this.stopConference();

      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      this.ctx = new Ctor();
      await this.ctx.resume();

      // Acquire mic
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      this.micNode = this.ctx.createMediaStreamSource(this.micStream);

      // Create outgoing destinations for each participant
      const outgoingDests = new Map<string, MediaStreamAudioDestinationNode>();
      for (const p of participantList) {
        const dest = this.ctx.createMediaStreamDestination();
        outgoingDests.set(p.id, dest);
        // Connect mic to outgoing destination
        this.micNode.connect(dest);
      }

      // Create remote sources for each participant
      const remoteSources: { id: string; pc: RTCPeerConnection; sourceNode: MediaStreamAudioSourceNode }[] = [];
      for (const p of participantList) {
        const remoteStream = new MediaStream();
        for (const receiver of p.pc.getReceivers()) {
          if (receiver.track?.kind === 'audio') {
            remoteStream.addTrack(receiver.track);
          }
        }
        if (remoteStream.getAudioTracks().length === 0) continue;
        const sourceNode = this.ctx.createMediaStreamSource(remoteStream);
        remoteSources.push({ id: p.id, pc: p.pc, sourceNode });
      }

      // Connect remote sources to local speaker (destination) and other participants' outgoing destinations
      for (const rs of remoteSources) {
        rs.sourceNode.connect(this.ctx.destination); // user hears this participant
        const otherDests: MediaStreamAudioDestinationNode[] = [];
        const destNode = outgoingDests.get(rs.id)!;

        for (const [otherId, dest] of outgoingDests) {
          if (otherId !== rs.id) {
            rs.sourceNode.connect(dest); // other participants hear this participant
            otherDests.push(dest);
          }
        }

        this.participants.set(rs.id, {
          sourceNode: rs.sourceNode,
          destNode,
          otherDests,
          muted: false,
        });
      }

      // Replace each peer connection's outgoing track with the mixed destination track
      for (const rs of remoteSources) {
        const dest = outgoingDests.get(rs.id);
        if (!dest) continue;
        const mixedTrack = dest.stream.getAudioTracks()[0];
        if (!mixedTrack) continue;
        const sender = rs.pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(mixedTrack);
          console.log('[audio-graph] replaced outgoing track for conference participant:', rs.id);
        }
      }

      return true;
    } catch (e) {
      console.error('[audio-graph] startConference failed:', e);
      this.stopConference();
      return false;
    }
  }

  stopConference(): void {
    this.participants.clear();
    if (this.micStream) {
      try {
        this.micStream.getTracks().forEach((t) => t.stop());
      } catch {}
      this.micStream = null;
    }
    this.micNode = null;
    if (this.ctx) {
      try {
        void this.ctx.close();
      } catch {}
      this.ctx = null;
    }
  }

  muteParticipant(id: string): boolean {
    const p = this.participants.get(id);
    if (!p || p.muted || !this.ctx) return false;
    try {
      p.sourceNode.disconnect(this.ctx.destination);
    } catch {}
    for (const dest of p.otherDests) {
      try {
        p.sourceNode.disconnect(dest);
      } catch {}
    }
    p.muted = true;
    console.log('[audio-graph] muted participant:', id);
    return true;
  }

  unmuteParticipant(id: string): boolean {
    const p = this.participants.get(id);
    if (!p || !p.muted || !this.ctx) return false;
    try {
      p.sourceNode.connect(this.ctx.destination);
    } catch {}
    for (const dest of p.otherDests) {
      try {
        p.sourceNode.connect(dest);
      } catch {}
    }
    p.muted = false;
    console.log('[audio-graph] unmuted participant:', id);
    return true;
  }

  isParticipantMuted(id: string): boolean {
    return !!this.participants.get(id)?.muted;
  }

  isConferenceActive(): boolean {
    return this.ctx !== null;
  }

  async startHoldMusic(id: string, pc: RTCPeerConnection, dataUrl: string): Promise<void> {
    try {
      this.stopHoldMusic(id);

      const audioEl = new Audio(dataUrl);
      audioEl.loop = true;
      audioEl.autoplay = true;
      audioEl.crossOrigin = 'anonymous';

      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new Ctor();
      await ctx.resume();

      const source = ctx.createMediaElementSource(audioEl);
      const dest = ctx.createMediaStreamDestination();
      source.connect(dest);

      const musicTrack = dest.stream.getAudioTracks()[0];
      if (!musicTrack) {
        console.warn('[audio-graph] hold music dest stream has no audio track');
        ctx.close();
        return;
      }

      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (!sender) {
        console.warn('[audio-graph] no audio sender on peer connection');
        ctx.close();
        return;
      }

      await sender.replaceTrack(musicTrack);
      await audioEl.play();

      this.holdMusics.set(id, { audioEl, ctx, dest });
      console.log('[audio-graph] hold music started for call:', id);
    } catch (e) {
      console.warn('[audio-graph] startHoldMusic failed:', e);
    }
  }

  async stopHoldMusic(id: string, pc?: RTCPeerConnection, constraints?: MediaTrackConstraints): Promise<void> {
    const stash = this.holdMusics.get(id);
    if (!stash) return;

    try {
      stash.audioEl.pause();
      stash.audioEl.src = '';
    } catch {}

    try {
      await stash.ctx.close();
    } catch {}

    this.holdMusics.delete(id);

    if (pc && constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        const micTrack = stream.getAudioTracks()[0];
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender && micTrack) {
          await sender.replaceTrack(micTrack);
          console.log('[audio-graph] hold music stopped, mic restored for call:', id);
        }
      } catch (e) {
        console.error('[audio-graph] failed to restore mic after hold music:', e);
      }
    }
  }

  clearAllHoldMusic(): void {
    for (const id of this.holdMusics.keys()) {
      this.stopHoldMusic(id);
    }
  }
}

export const audioGraphService = new AudioGraphService();
