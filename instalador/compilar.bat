@echo off
rem Gera o PODCAST_PRO_Instalador.exe a partir do Instalador.cs e dos arquivos da pasta "rec"
rem (copie para "rec" os arquivos da versao atual do repositorio: server.py, painel_*.*, img_*.png,
rem  base_modelos.prproj, face_detection_yunet_2023mar.onnx, requirements.txt, PODCAST_PRO.ccx e instalador.html)
set FW=C:\Windows\Microsoft.NET\Framework64\v4.0.30319
set RES=
pushd "%~dp0..\rec"
for %%f in (*) do call set RES=%%RES%% /resource:%%f,%%f
"%FW%\csc.exe" -nologo -target:winexe -optimize+ -out:"%~dp0..\PODCAST_PRO_Instalador_v13.exe" -r:"%FW%\System.IO.Compression.dll" -r:"%FW%\System.IO.Compression.FileSystem.dll" %RES% "%~dp0Instalador.cs"
popd
