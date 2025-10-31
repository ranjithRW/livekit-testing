import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Room, RoomEvent, TokenSource } from 'livekit-client';
import { AppConfig } from '@/app-config';
import { toastAlert } from '@/components/livekit/alert-toast';

export function useRoom(appConfig: AppConfig) {
  const aborted = useRef(false);
  const room = useMemo(() => {
    const r = new Room({
      // Increase connection timeout to 30 seconds
      connectTimeout: 30000,
      // Enable adaptive stream
      adaptiveStream: true,
    });
    return r;
  }, []);
  const [isSessionActive, setIsSessionActive] = useState(false);

  useEffect(() => {
    function onDisconnected() {
      setIsSessionActive(false);
    }

    function onMediaDevicesError(error: Error) {
      toastAlert({
        title: 'Encountered an error with your media devices',
        description: `${error.name}: ${error.message}`,
      });
    }

    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      console.log('Room connection state changed:', state);
      if (state === 'disconnected' || state === 'reconnecting') {
        // Don't set session inactive on reconnecting, only on disconnect
        if (state === 'disconnected') {
          setIsSessionActive(false);
        }
      }
    });

    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.ConnectionStateChanged);
    };
  }, [room]);

  useEffect(() => {
    return () => {
      aborted.current = true;
      room.disconnect();
    };
  }, [room]);

  const tokenSource = useMemo(
    () =>
      TokenSource.custom(async () => {
        const url = new URL(
          process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? '/api/connection-details',
          window.location.origin
        );

        try {
          const res = await fetch(url.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Sandbox-Id': appConfig.sandboxId ?? '',
            },
            body: JSON.stringify({
              room_config: appConfig.agentName
                ? {
                    agents: [{ agent_name: appConfig.agentName }],
                  }
                : undefined,
            }),
          });

          if (!res.ok) {
            const errorText = await res.text();
            console.error('Connection details API error:', errorText);
            throw new Error(`Failed to get connection details: ${errorText}`);
          }

          const data = await res.json();
          console.log('Connection details received:', { serverUrl: data.serverUrl, roomName: data.roomName });
          return data;
        } catch (error) {
          console.error('Error fetching connection details:', error);
          throw error instanceof Error ? error : new Error('Error fetching connection details!');
        }
      }),
    [appConfig]
  );

  const startSession = useCallback(() => {
    setIsSessionActive(true);

    if (room.state === 'disconnected') {
      const { isPreConnectBufferEnabled } = appConfig;
      
      // First connect to the room, then enable microphone after connection is established
      tokenSource
        .fetch({ agentName: appConfig.agentName })
        .then((connectionDetails) => {
          console.log('Connecting to room:', connectionDetails.roomName);
          return room.connect(connectionDetails.serverUrl, connectionDetails.participantToken, {
            // Connection options
            autoSubscribe: true,
          });
        })
        .then(async () => {
          console.log('Room connected, enabling microphone...');
          // Wait for room to be fully connected before enabling microphone
          // The connect() promise resolves when connected, but ensure state is ready
          if (room.state !== 'connected') {
            await new Promise<void>((resolve) => {
              const onConnected = () => {
                room.off(RoomEvent.Connected, onConnected);
                resolve();
              };
              room.on(RoomEvent.Connected, onConnected);
              // Timeout safety
              setTimeout(() => {
                room.off(RoomEvent.Connected, onConnected);
                resolve();
              }, 5000);
            });
          }
          
          // Now that room is connected, enable microphone
          try {
            await room.localParticipant.setMicrophoneEnabled(true, undefined, {
              preConnectBuffer: isPreConnectBufferEnabled,
            });
            console.log('Microphone enabled');
          } catch (micError) {
            console.error('Error enabling microphone:', micError);
            // Don't fail the whole session if mic fails, but log it
            throw micError;
          }
        })
        .catch((error) => {
          if (aborted.current) {
            // Once the effect has cleaned up after itself, drop any errors
            //
            // These errors are likely caused by this effect rerunning rapidly,
            // resulting in a previous run `disconnect` running in parallel with
            // a current run `connect`
            return;
          }

          console.error('Session start error:', error);
          
          // Ensure room is disconnected on error
          if (room.state !== 'disconnected') {
            room.disconnect().catch(console.error);
          }

          setIsSessionActive(false);
          
          // Provide more helpful error messages
          let errorMessage = error.message || 'Unknown error';
          if (errorMessage.includes('timeout') || errorMessage.includes('signal')) {
            errorMessage = 'Connection timeout. Please check your LiveKit server configuration and environment variables.';
          }

          toastAlert({
            title: 'There was an error connecting to the agent',
            description: `${error.name}: ${errorMessage}`,
          });
        });
    }
  }, [room, appConfig, tokenSource]);

  const endSession = useCallback(() => {
    setIsSessionActive(false);
  }, []);

  return { room, isSessionActive, startSession, endSession };
}
